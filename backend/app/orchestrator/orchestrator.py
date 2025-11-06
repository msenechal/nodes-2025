import os
import asyncio
import time
from typing import Dict, List, Any, Optional
from datetime import datetime
import threading
import asyncio

from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, BaseMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

from models import MultiAgentResponse, AgentTask, AgentStatus, Agent
from app.agents.neo4j_agent import Neo4jGraphRAGAgent
from app.agents.llm_agent import LLMAgent
from app.agents.supervisor_agent import SupervisorAgent, Task, AgentPlan

import logging
logger = logging.getLogger(__name__)


class MultiAgentOrchestrator:
    
    def __init__(self, openai_api_key: str, 
                 neo4j_uri: str = None, neo4j_username: str = None, neo4j_password: str = None,
                 connection_manager=None, agent_configs=None):
        self.openai_api_key = openai_api_key
        self.connection_manager = connection_manager
        self.current_session_id = None

        self.planning_completed = False

        self._current_task_graph_data = None
        self.last_graph_data = None

        from app.config.agents import get_default_agents
        self.agent_configs = agent_configs or {agent.id: agent for agent in get_default_agents()}

        self.supervisor = SupervisorAgent(openai_api_key, self.agent_configs)

        self.neo4j_graphrag = None
        if neo4j_uri and neo4j_username and neo4j_password:
            try:
                self.neo4j_graphrag = Neo4jGraphRAGAgent(neo4j_uri, neo4j_username, neo4j_password, openai_api_key)
                logger.info("Neo4j GraphRAG initialized successfully")
            except Exception as e:
                logger.error(f"Neo4j GraphRAG initialization failed: {e}")
                self.neo4j_graphrag = None

        self._setup_tools()
        self._setup_agents()
        
        logger.info("Multi-Agent Orchestrator initialized successfully")
    
    def update_agent_configs(self, agent_configs):
        if isinstance(agent_configs, list):
            self.agent_configs = {agent.id: agent for agent in agent_configs}
        else:
            self.agent_configs = agent_configs

        self.supervisor.update_agent_configs(self.agent_configs)
        logger.info(f"Orchestrator: Agent configurations updated: {list(self.agent_configs.keys())}")
    
    def get_enabled_agents(self):
        return [agent for agent in self.agent_configs.values() if agent.isEnabled]
    
    def _setup_tools(self):
        @tool(description="Perform a Neo4j GraphRAG contextual search and return the summarized answer.")
        def graphrag_search(query: str) -> str:
            if not self.neo4j_graphrag:
                return "Neo4j GraphRAG is not available. Please check the database connection."
            
            try:
                logger.info(f"Neo4j GraphRAG search: {query[:100]}...")
                context_result = self.neo4j_graphrag.search_with_context(query)

                self._current_task_graph_data = context_result
                self.last_graph_data = context_result
                
                answer = context_result.get('answer', 'No answer found')
                
                logger.info(f"Neo4j GraphRAG result: {len(answer)} characters")
                logger.info(f"- retrieved nodes: {len(context_result.get('retrieved_nodes', []))}")
                logger.info(f"- retrieved relationships: {len(context_result.get('retrieved_relationships', []))}")
                
                return answer
            except Exception as e:
                logger.error(f"Neo4j GraphRAG error: {e}")
                return f"GraphRAG search failed: {str(e)[:200]}"
        
        self.graphrag_search = graphrag_search
    
    def _setup_agents(self):
        agent_model = ChatOpenAI(api_key=self.openai_api_key, model=os.getenv("LLM_MODEL", "gpt-4o-mini"))

        self.llm_agent = LLMAgent()

        self.neo4j_agent = create_react_agent(
            model=agent_model,
            tools=[self.graphrag_search] if self.neo4j_graphrag else [],
            prompt=(
                "You are a Neo4j GraphRAG search specialist agent.\n\n"
                "INSTRUCTIONS:\n"
                "- You receive specific questions from the supervisor that need graph database knowledge\n"
                "- Use the graphrag_search tool to query the Neo4j graph database\n"
                "- Focus ONLY on the specific question assigned to you\n"
                "- The query you receive has been cleaned and summarized by the planner\n"
                "- Use graphrag_search with the exact question provided\n"
                "- Return the GraphRAG search results directly\n"
                "- Do NOT try to generate charts or perform other tasks\n"
                "- Your role is purely knowledge retrieval from the graph database"
            ),
            name="neo4j_agent"
        )

        self.agents_map = {
            "llm_agent": self.llm_agent,
            "neo4j_agent": self.neo4j_agent,
        }
    
    async def process_query(self, query: str, session_id: str = None, conversation_history: List = None) -> MultiAgentResponse:
        start_time = time.time()
        self.current_session_id = session_id
        self.planning_completed = False
        
        try:
            logger.info(f"Starting multi-agent processing for: {query[:100]}...")

            self._send_supervisor_status_sync("Analyzing query and planning tasks...")

            plan = self.supervisor.create_plan(query, conversation_history)
            self.planning_completed = True
            self._send_planner_completion_update(plan)

            tasks = {task.id: task for task in plan.tasks}

            self._send_websocket_update_sync(tasks, plan)

            for task_id, task in tasks.items():
                try:
                    logger.info(f"Executing task {task_id}: {task.description[:50]}...")

                    task.status = "running"
                    task.started_at = datetime.now().isoformat()
                    self._send_websocket_update_sync(tasks, plan)

                    result = await self._execute_task(task, tasks)

                    task.status = "completed"
                    task.result = result
                    task.completed_at = datetime.now().isoformat()
                    
                    logger.info(f"Task {task_id} completed: {len(result)} characters")
                    
                except Exception as e:
                    logger.error(f"Task {task_id} failed: {e}")
                    task.status = "failed"
                    task.result = f"Task failed: {str(e)}"
                    task.completed_at = datetime.now().isoformat()

                self._send_websocket_update_sync(tasks, plan)

            self._send_supervisor_status_sync("All tasks completed, generating results...")
            
            final_answer = self.supervisor.synthesize_results(tasks, query)

            session_title = self.supervisor.generate_session_title(query)
            self._send_session_title_update(session_title)

            self._send_supervisor_status_sync("Workflow completed successfully")
            
            processing_time = time.time() - start_time

            agent_tasks = self._convert_tasks_to_agent_tasks(tasks, plan)
            
            response = MultiAgentResponse(
                query=query,
                response=final_answer,
                agents_used=[task.agent for task in tasks.values()],
                processing_time=processing_time,
                synthesis_applied=True,
                agentTasks=agent_tasks,
                totalTime=int(processing_time * 1000),
                sessionTitle=session_title
            )
            
            logger.info(f"Multi-agent processing completed in {processing_time:.2f}s")
            return response
            
        except Exception as e:
            logger.info(f"Multi-agent processing error: {e}")
            processing_time = time.time() - start_time
            
            return MultiAgentResponse(
                query=query,
                response=f"I apologize, but I encountered an error while processing your request: {str(e)}",
                agents_used=[],
                processing_time=processing_time,
                synthesis_applied=False,
                totalTime=int(processing_time * 1000)
            )
    
    async def _execute_task(self, task: Task, all_tasks: Dict[str, Task]) -> str:
        context_from_previous_tasks = ""
        for prev_task_id, prev_task in all_tasks.items():
            if prev_task.status == "completed" and prev_task_id != task.id:
                context_from_previous_tasks += f"\n\nPrevious result from {prev_task.agent}: {prev_task.result}"
        
        enhanced_input = task.description
        if context_from_previous_tasks:
            enhanced_input += f"\n\nContext from previous tasks:{context_from_previous_tasks}"
        
        task.actual_input = enhanced_input
        
        agent = self.agents_map.get(task.agent)
        if not agent:
            raise ValueError(f"Agent {task.agent} not found")
        
        self._current_task_graph_data = None
        self.last_graph_data = None
        
        if task.agent == "llm_agent":
            result = agent.search(enhanced_input)
        elif task.agent == "neo4j_agent":
            state = {"messages": [HumanMessage(content=enhanced_input)]}
            agent_result = agent.invoke(state)
            
            if "messages" in agent_result and agent_result["messages"]:
                result = agent_result["messages"][-1].content
                
                graph_data = getattr(self, '_current_task_graph_data', None) or getattr(self, 'last_graph_data', None)
                if graph_data:
                    logger.info(f"Adding graph data to neo4j_agent task {task.id}")
                    task.graph_data = graph_data
                    logger.info(f"- retrieved nodes: {len(graph_data.get('retrieved_nodes', []))}")
                    logger.info(f"- retrieved relationships: {len(graph_data.get('retrieved_relationships', []))}")
            else:
                result = "No response from Neo4j agent"
        else:
            raise ValueError(f"Unknown agent type: {task.agent}")
        
        return result
    
    def _convert_tasks_to_agent_tasks(self, tasks: Dict[str, Task], plan: AgentPlan) -> List[AgentTask]:
        agent_tasks = []
        
        all_completed = all(task.status == "completed" for task in tasks.values()) if tasks else True
        
        plan_details = f"""**Query Analysis**: {plan.analysis}
							**Strategy**: {plan.strategy}
							**Task Breakdown**:"""
        
        for i, task in enumerate(plan.tasks, 1):
            plan_details += f"\n{i}. {task.agent.replace('_', ' ').title()}: {task.description}"
        
        supervisor_task = AgentTask(
            id="supervisor_plan",
            agentId="planner",
            agentName="Planner",
            agentColor="#607D8B",
            task="Planning and coordinating task execution",
            status=AgentStatus.COMPLETED if self.planning_completed else AgentStatus.RUNNING,
            result=plan_details if self.planning_completed else "",
            input=plan.original_query
        )
        agent_tasks.append(supervisor_task)
        
        for task in tasks.values():
            agent_status = AgentStatus.PENDING
            if task.status == "running":
                agent_status = AgentStatus.RUNNING
            elif task.status == "completed":
                agent_status = AgentStatus.COMPLETED
            elif task.status == "failed":
                agent_status = AgentStatus.FAILED
            
            start_time = None
            end_time = None
            try:
                if hasattr(task, 'started_at') and task.started_at:
                    start_time = int(datetime.fromisoformat(task.started_at.replace('Z', '+00:00')).timestamp() * 1000)
                if hasattr(task, 'completed_at') and task.completed_at:
                    end_time = int(datetime.fromisoformat(task.completed_at.replace('Z', '+00:00')).timestamp() * 1000)
            except Exception as e:
                logger.info(f"Warning: Could not parse task timing for {task.id}: {e}")
            
            graph_data = None
            if hasattr(task, 'graph_data') and task.graph_data:
                graph_data = task.graph_data
            
            agent_task = AgentTask(
                id=task.id,
                agentId=task.agent,
                agentName=task.agent.replace("_", " ").title(),
                agentColor=self._get_agent_color(task.agent),
                task=task.description,
                status=agent_status,
                startTime=start_time,
                endTime=end_time,
                result=task.result if task.status == "completed" else None,
                error=task.result if task.status == "failed" else None,
                progress=100 if task.status == "completed" else (50 if task.status == "running" else 0),
                input=getattr(task, 'actual_input', task.description),
                graphData=graph_data
            )
            agent_tasks.append(agent_task)
        
        return agent_tasks
    
    def _get_agent_color(self, agent_name: str) -> str:
        if agent_name in self.agent_configs:
            return self.agent_configs[agent_name].color
        
        colors = {
            "llm_agent": "#3F51B5",
            "neo4j_agent": "#F44336",
            "supervisor": "#607D8B"
        }
        return colors.get(agent_name, "#757575")
    
    def _send_planner_completion_update(self, plan: AgentPlan):
        if not self.connection_manager or not self.current_session_id:
            return
            
        try:
            from models import MultiTaskUpdate, AgentTask, AgentStatus
            plan_details = f"""**Query Analysis**: {plan.analysis}

**Strategy**: {plan.strategy}

**Task Breakdown**:"""
            
            for i, task in enumerate(plan.tasks, 1):
                plan_details += f"\n{i}. {task.agent.replace('_', ' ').title()}: {task.description}"
            
            planner_task = AgentTask(
                id="supervisor_plan",
                agentId="planner",
                agentName="Planner", 
                agentColor="#607D8B",
                task="Planning and coordinating task execution",
                status=AgentStatus.COMPLETED,
                result=plan_details,
                input=plan.original_query
            )
            
            update = MultiTaskUpdate(
                sessionId=self.current_session_id,
                tasks=[planner_task]
            )
            
            logger.info("Planner completed - sending plan details update")
            
            def send_planner_update():
                try:
                    new_loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(new_loop)
                    new_loop.run_until_complete(
                        self.connection_manager.send_multi_task_update(self.current_session_id, update)
                    )
                    new_loop.close()
                except Exception as e:
                    logger.error(f"Error in threaded planner update: {e}")
            
            thread = threading.Thread(target=send_planner_update)
            thread.daemon = True
            thread.start()
            thread.join(timeout=0.5)
            
        except Exception as e:
            logger.error(f"Error sending planner completion update: {e}")

    def _send_supervisor_status_sync(self, status_message: str):
        if not self.connection_manager or not self.current_session_id:
            return
            
        try:
            from models import MultiTaskUpdate, AgentTask, AgentStatus
            
            task_status = AgentStatus.COMPLETED if "Workflow completed successfully" in status_message else AgentStatus.RUNNING
            
            supervisor_task = AgentTask(
                id="supervisor_status",
                agentId="supervisor",
                agentName="Supervisor",
                agentColor="#607D8B",
                task=status_message,
                status=task_status,
                result="",
                input=status_message
            )
            
            update = MultiTaskUpdate(
                sessionId=self.current_session_id,
                tasks=[supervisor_task]
            )
            
            logger.info(f"Supervisor status: {status_message}")
            
            def send_status():
                try:
                    new_loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(new_loop)
                    new_loop.run_until_complete(
                        self.connection_manager.send_multi_task_update(self.current_session_id, update)
                    )
                    new_loop.close()
                except Exception as e:
                    logger.info(f"Error in threaded supervisor status: {e}")
            
            thread = threading.Thread(target=send_status)
            thread.daemon = True
            thread.start()
            thread.join(timeout=0.5)
            
        except Exception as e:
            logger.info(f"Error sending supervisor status: {e}")
    
    def _send_websocket_update_sync(self, tasks: Dict[str, Task], plan: AgentPlan):
        if not self.connection_manager or not self.current_session_id:
            return
            
        try:
            agent_tasks = self._convert_tasks_to_agent_tasks(tasks, plan)
            
            from models import MultiTaskUpdate
            update = MultiTaskUpdate(
                sessionId=self.current_session_id,
                tasks=agent_tasks
            )
            
            logger.info(f"Sending task update for {len(agent_tasks)} tasks")
            
            def send_update():
                try:
                    new_loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(new_loop)
                    new_loop.run_until_complete(
                        self.connection_manager.send_multi_task_update(self.current_session_id, update)
                    )
                    new_loop.close()
                except Exception as e:
                    logger.info(f"Error in threaded task update: {e}")
            
            thread = threading.Thread(target=send_update)
            thread.daemon = True
            thread.start()
            thread.join(timeout=1.0)
            
        except Exception as e:
            logger.info(f"Error sending task update: {e}")
    
    def _send_session_title_update(self, title: str):
        if not self.connection_manager or not self.current_session_id:
            return
            
        try:
            title_update = {
                "type": "session_title_update", 
                "sessionId": self.current_session_id,
                "title": title
            }
            
            logger.info(f"Sending session title update: {title}")
            
            def send_title():
                try:
                    new_loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(new_loop)
                    new_loop.run_until_complete(
                        self.connection_manager.send_json_message(self.current_session_id, title_update)
                    )
                    new_loop.close()
                except Exception as e:
                    logger.info(f"Error in threaded session title update: {e}")
            
            thread = threading.Thread(target=send_title)
            thread.daemon = True
            thread.start()
            thread.join(timeout=0.5)
            
        except Exception as e:
            logger.info(f"Error sending session title update: {e}")

__all__ = ["MultiAgentOrchestrator"]
