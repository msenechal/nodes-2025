import os
import json
from typing import Dict, List, Any, Optional
from datetime import datetime
from dataclasses import dataclass, field

from langchain_core.messages import SystemMessage
from langchain_openai import ChatOpenAI

from models import AgentTask, AgentStatus, Agent

import logging
logger = logging.getLogger(__name__)


@dataclass
class Task:
    id: str
    description: str
    agent: str
    status: str = "pending"
    result: str = ""
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    actual_input: Optional[str] = None
    graph_data: Optional[Dict[str, Any]] = None


@dataclass 
class AgentPlan:
    original_query: str
    analysis: str
    tasks: List[Task]
    strategy: str
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())


class SupervisorAgent:
    
    def __init__(self, openai_api_key: str, agent_configs: Dict[str, Agent] = None):
        self.model = ChatOpenAI(api_key=openai_api_key, model=os.getenv("LLM_MODEL", "gpt-4o-mini"))
        self.agent_configs = agent_configs or {}
        
    def update_agent_configs(self, agent_configs):
        if isinstance(agent_configs, list):
            self.agent_configs = {agent.id: agent for agent in agent_configs}
        else:
            self.agent_configs = agent_configs
        logger.info(f"Supervisor: Agent configurations updated: {list(self.agent_configs.keys())}")
    
    def get_enabled_agents(self) -> List[Agent]:
        return [agent for agent in self.agent_configs.values() if agent.isEnabled]
    
    def create_plan(self, query: str, conversation_history: List = None) -> AgentPlan:
        enabled_agents = self.get_enabled_agents()
        agent_descriptions = []
        for agent in enabled_agents:
            tools_str = ", ".join(agent.tools)
            agent_descriptions.append(f"- {agent.id}: {agent.description} (Tools: {tools_str})")
        
        available_agents_text = "\n".join(agent_descriptions) if agent_descriptions else "No agents are currently enabled."
        
        conversation_context = ""
        if conversation_history and len(conversation_history) > 0:
            conversation_context = "\n\nCONVERSATION HISTORY:\n"
            for i, msg in enumerate(conversation_history[-5:]):
                role_display = "Human" if msg.get('role') == 'user' else "Assistant"
                conversation_context += f"{role_display}: {msg.get('content', '')}\n"
            conversation_context += f"\nCurrent Query: {query}\n"
            conversation_context += "\nIMPORTANT: Consider the conversation context when planning tasks. This may be a follow-up question or reference to previous discussion.\n"
            
        import re
        explicit_data_pattern = r'(\w+)\s*[=:]\s*(\d+\.?\d*)'
        data_matches = re.findall(explicit_data_pattern, query)
        
        data_context = ""
        if data_matches:
            data_pairs = [f"{label}={value}" for label, value in data_matches]
            data_context = f"\n\nIMPORTANT: Original data from user query: {', '.join(data_pairs)}"
            print(f"🎯 Supervisor: Detected explicit data in query: {data_pairs}")
        
        routing_guidelines = []
        enabled_agent_ids = [agent.id for agent in enabled_agents]
        
        if "neo4j_agent" in enabled_agent_ids:
            routing_guidelines.append("- For movie related questions ALWAYS use neo4j_agent for SHORT concise questions/answers. This is a graphRAG search agent.")
        if "llm_agent" in enabled_agent_ids:
            routing_guidelines.append("- For general knowledge, research, analysis, explanations, or information, use llm_agent")
        
        routing_text = "\n".join(routing_guidelines) if routing_guidelines else "No specific routing guidelines - use available agents as appropriate."
        
        planning_prompt = f"""
You are an expert supervisor that creates detailed execution plans for multi-agent systems.
{conversation_context}
Analyze this user query: "{query}"{data_context}

Create a comprehensive plan that:
1. Analyzes what information is needed
2. Breaks down the query into specific, actionable tasks
3. Assigns each task to the most appropriate specialist agent
4. Ensures all necessary information will be gathered
5. PRESERVES any explicit data values from the original query
6. Consider conversation context - this may be a follow-up question or reference to previous discussion

Available specialist agents:
{available_agents_text}

Special routing guidelines:
{routing_text}

IMPORTANT: Only use agents that are listed as available above. Keep tasks focused and specific.

For each task, specify:
- Unique task ID (task_1, task_2, etc.)
- Clear, specific task description  
- Which agent should handle it
- What specific output is expected

Return your response in this exact JSON format:
{{
    "analysis": "Your analysis of what needs to be done",
    "strategy": "Your overall approach strategy", 
    "tasks": [
        {{
            "id": "task_1",
            "description": "Specific task description",
            "agent": "agent_name",
            "expected_output": "What output format/content is expected"
        }}
    ]
}}
"""
        
        try:
            response = self.model.invoke([SystemMessage(content=planning_prompt)])
            
            response_text = response.content.strip()
            if response_text.startswith("```json"):
                response_text = response_text.split("```json")[1].split("```")[0]
            elif response_text.startswith("```"):
                response_text = response_text.split("```")[1].split("```")[0]
            
            plan_data = json.loads(response_text)
            
            tasks = []
            for task_data in plan_data.get("tasks", []):
                task = Task(
                    id=task_data["id"],
                    description=task_data["description"],
                    agent=task_data["agent"]
                )
                tasks.append(task)
            
            plan = AgentPlan(
                original_query=query,
                analysis=plan_data.get("analysis", "Analysis not provided"),
                strategy=plan_data.get("strategy", "Strategy not provided"),
                tasks=tasks
            )
            
            logger.info(f"Supervisor: Created plan with {len(tasks)} tasks")
            for task in tasks:
                logger.info(f"- {task.id}: {task.agent} -> {task.description[:60]}...")
            
            return plan
            
        except Exception as e:
            logger.info(f"Supervisor: Error creating plan: {e}")
            fallback_task = Task(
                id="task_1",
                description=f"Handle query: {query}",
                agent="llm_agent" if "llm_agent" in enabled_agent_ids else enabled_agent_ids[0] if enabled_agent_ids else "llm_agent"
            )
            
            return AgentPlan(
                original_query=query,
                analysis="Fallback analysis due to planning error",
                strategy="Direct delegation to available agent",
                tasks=[fallback_task]
            )
    
    def generate_session_title(self, query: str) -> str:
        title_prompt = f"""
Generate a very short, concise title (max 6 words) for this user query:
"{query}"

The title should capture the main topic or intent. Be specific but brief.
Examples:
- "Neo4j authentication setup"
- "Python data visualization"
- "React component optimization"

Return only the title, nothing else.
"""
        
        try:
            response = self.model.invoke([SystemMessage(content=title_prompt)])
            title = response.content.strip().strip('"\'')
            
            if len(title) > 50:
                title = title[:47] + "..."
            
            logger.info(f"Supervisor: Generated session title: {title}")
            return title
            
        except Exception as e:
            logger.info(f"Supervisor: Title generation error: {e}")
            words = query.split()[:6]
            return " ".join(words) + ("..." if len(query.split()) > 6 else "")
    
    def synthesize_results(self, tasks: Dict[str, Task], original_query: str) -> str:
        completed_tasks = {k: v for k, v in tasks.items() if v.status == "completed"}
        
        if not completed_tasks:
            return "I apologize, but I wasn't able to complete any tasks to answer your query."

        task_results = []
        for task_id, task in completed_tasks.items():
            task_results.append(f"**{task.agent.replace('_', ' ').title()}**: {task.result}")
        
        synthesis_prompt = f"""
You are a synthesis expert. Combine the following task results into a comprehensive, well-structured answer to the original user query.

Original Query: "{original_query}"

Task Results:
{chr(10).join(task_results)}

Instructions:
1. Synthesize the information into a coherent, comprehensive response
2. Maintain accuracy - only use information provided in the task results
3. Structure the response logically with clear sections if appropriate
4. If there are any charts or visual data, mention them appropriately
5. Make the response engaging and directly address the user's query
6. If task results contradict each other, acknowledge the discrepancy

Provide a complete, well-formatted response:
"""
        
        try:
            response = self.model.invoke([SystemMessage(content=synthesis_prompt)])
            synthesized_result = response.content.strip()
            
            logger.info(f"Supervisor: Synthesized results from {len(completed_tasks)} tasks")
            return synthesized_result
            
        except Exception as e:
            logger.info(f"Supervisor: Error in synthesis: {e}")
            return "\n\n".join([f"**{task.agent.replace('_', ' ').title()}**: {task.result}" 
                               for task in completed_tasks.values()])