import os
import logging
from typing import Dict, Any, List, Optional
from datetime import datetime
import uuid
import neo4j
from neo4j import GraphDatabase
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)

class Neo4jAuditLogger:
    def __init__(self, uri: str = None, username: str = None, password: str = None):
        self.uri = uri or os.getenv("NEO4J_AUDIT_URI")
        self.username = username or os.getenv("NEO4J_AUDIT_USERNAME") 
        self.password = password or os.getenv("NEO4J_AUDIT_PASSWORD")
        self.database = os.getenv("NEO4J_AUDIT_DATABASE", "neo4j")
        
        if not all([self.uri, self.username, self.password]):
            logger.warning("Neo4j audit database credentials not provided. Audit logging disabled.")
            self.driver = None
            return
            
        try:
            self.driver = GraphDatabase.driver(self.uri, auth=(self.username, self.password), notifications_min_severity='WARNING')
            self.driver.verify_connectivity()
            logger.info(f"Neo4j audit db connection established (database: {self.database})")
        except Exception as e:
            logger.error(f"Failed to connect to Neo4j audit db: {e}")
            self.driver = None
    
    def log_question_workflow(self, 
                            session_id: str,
                            question: str, 
                            agent_tasks: List[Dict[str, Any]],
                            response: str,
                            agents_used: List[str],
                            processing_time: float,
                            sources: List[str] = None,
                            graph_data: Dict[str, Any] = None,
                            model: str = "gpt-4o-mini",
                            is_multi_agent: bool = True) -> str:
        if not self.driver:
            logger.warning("Audit database not available - skipping audit log")
            return None
            
        question_id = str(uuid.uuid4())
        timestamp = datetime.now().isoformat()
        
        try:
            with self.driver.session(database=self.database) as neo4j_session:
                neo4j_session.run("""
                    MERGE (u: User {email: "morgan@neo4j.com"})
                    WITH u
                    CREATE (q:Question {
                        id: $question_id,
                        text: $question,
                        timestamp: $timestamp,
                        response: $response,
                        model: $model,
                        processing_time: $processing_time,
                        is_multi_agent: $is_multi_agent,
                        agents_count: $agents_count,
                        sources_count: $sources_count
                    })
                    CREATE (u)-[:ASKED {askedDate: $timestamp}]->(q)
                """, {
                    "question_id": question_id,
                    "question": question,
                    "timestamp": timestamp,
                    "response": response,
                    "model": model,
                    "processing_time": processing_time,
                    "is_multi_agent": is_multi_agent,
                    "agents_count": len(agents_used) if agents_used else 0,
                    "sources_count": len(sources) if sources else 0,
                    "timestamp": timestamp
                })
                
                orchestrator_id = f"orchestrator_{question_id}"
                neo4j_session.run("""
                    MATCH (q:Question {id: $question_id})
                    CREATE (o:Orchestrator {
                        id: $orchestrator_id,
                        type: "Multi-Agent Orchestrator",
                        timestamp: $timestamp
                    })
                    CREATE (q)-[:TRIGGERED]->(o)
                """, {
                    "question_id": question_id,
                    "orchestrator_id": orchestrator_id,
                    "timestamp": timestamp
                })
                agent_results = self._create_agents_and_workflow(neo4j_session, question_id, orchestrator_id, agent_tasks, timestamp)

                if sources:
                    self._create_sources(neo4j_session, question_id, sources, timestamp)

                if graph_data:
                    if isinstance(graph_data, list):
                        for idx, retrieval_entry in enumerate(graph_data):
                            gd = retrieval_entry.get('graph_data') if isinstance(retrieval_entry, dict) else retrieval_entry
                            agent_name = retrieval_entry.get('agent_name') if isinstance(retrieval_entry, dict) else None
                            task_id = retrieval_entry.get('task_id') if isinstance(retrieval_entry, dict) else None
                            if gd:
                                self._create_graph_data(
                                    neo4j_session,
                                    question_id,
                                    orchestrator_id,
                                    agent_tasks,
                                    gd,
                                    timestamp,
                                    retrieval_suffix=f"_{idx}",
                                    neo4j_agent_name=agent_name,
                                    task_id=task_id,
                                    agent_results=agent_results
                                )
                    else:
                        self._create_graph_data(neo4j_session, question_id, orchestrator_id, agent_tasks, graph_data, timestamp, agent_results=agent_results)
                
                logger.info(f"Logged question to audit db: {question_id}")
                return question_id
                
        except Exception as e:
            logger.error(f"Failed to log question : {e}")
            return None
    
    def _create_agents_and_workflow(self, session, question_id: str, orchestrator_id: str, agent_tasks: List[Dict[str, Any]], timestamp: str):
        agents_by_type = {}
        task_details = []
        
        for i, task in enumerate(agent_tasks):
            agent_name = task.get('agent', 'Unknown')
            agent_type = task.get('type', agent_name)
            
            task_description = task.get('task', '')
            task_result = task.get('result', '')
            task_input = task.get('input', '')
            
            task_details.append({
                'index': i,
                'agent_name': agent_name,
                'agent_type': agent_type,
                'task_description': task_description,
                'task_result': task_result,
                'task_input': task_input
            })
            
            if agent_type not in agents_by_type:
                agents_by_type[agent_type] = {
                    'agent_name': agent_name,
                    'agent_id': f"{agent_name.lower().replace(' ', '_')}_{question_id}",
                    'tasks': []
                }
            agents_by_type[agent_type]['tasks'].append(i)
        
        for agent_type, agent_info in agents_by_type.items():
            session.run("""
                CREATE (a:Agent {
                    id: $agent_id,
                    name: $agent_name,
                    type: $agent_type,
                    timestamp: $timestamp,
                    task_count: $task_count
                })
            """, {
                "agent_id": agent_info['agent_id'],
                "agent_name": agent_info['agent_name'],
                "agent_type": agent_type,
                "timestamp": timestamp,
                "task_count": len(agent_info['tasks'])
            })
            
            session.run("""
                MATCH (o:Orchestrator {id: $orchestrator_id})
                MATCH (a:Agent {id: $agent_id})
                CREATE (o)-[:USE_AGENT]->(a)
            """, {
                "orchestrator_id": orchestrator_id,
                "agent_id": agent_info['agent_id']
            })

        agent_results = {}
        
        for task_detail in task_details:
            i = task_detail['index']
            agent_name = task_detail['agent_name']
            agent_type = task_detail['agent_type']
            task_description = task_detail['task_description']
            task_result = task_detail['task_result']
            task_input = task_detail['task_input']
            
            agent_id = agents_by_type[agent_type]['agent_id']
            
            task_id = f"task_{question_id}_{i}"
            session.run("""
                CREATE (t:Task {
                    id: $task_id,
                    description: $task_description,
                    input: $task_input,
                    timestamp: $timestamp,
                    order: $order
                })
            """, {
                "task_id": task_id,
                "task_description": task_description,
                "task_input": task_input,
                "timestamp": timestamp,
                "order": i
            })
            
            result_id = f"result_{question_id}_{i}"
            session.run("""
                CREATE (r:Result {
                    id: $result_id,
                    content: $task_result,
                    agent_name: $agent_name,
                    timestamp: $timestamp,
                    order: $order
                })
            """, {
                "result_id": result_id,
                "task_result": task_result,
                "agent_name": agent_name,
                "timestamp": timestamp,
                "order": i
            })
            
            session.run("""
                MATCH (t:Task {id: $task_id})
                MATCH (r:Result {id: $result_id})
                CREATE (t)-[:PRODUCED]->(r)
            """, {
                "task_id": task_id,
                "result_id": result_id
            })
            
            session.run("""
                MATCH (a:Agent {id: $agent_id})
                MATCH (t:Task {id: $task_id})
                CREATE (a)-[:ASSIGNED]->(t)
            """, {
                "agent_id": agent_id,
                "task_id": task_id
            })

            agent_results[f"{agent_name}_{i}"] = result_id
        
        for task_detail in task_details:
            i = task_detail['index']
            agent_name = task_detail['agent_name']
            agent_type = task_detail['agent_type']
            task_input = task_detail['task_input']
            
            agent_id = agents_by_type[agent_type]['agent_id']
            
            for prev_key, prev_result_id in agent_results.items():
                prev_agent_name = prev_key.split('_')[0] 
                if prev_agent_name != agent_name and prev_result_id:
                    if i > 0:
                        session.run("""
                            MATCH (a:Agent {id: $agent_id})
                            MATCH (r:Result {id: $prev_result_id})
                            CREATE (a)-[:USED_INPUT_FROM]->(r)
                        """, {
                            "agent_id": agent_id,
                            "prev_result_id": prev_result_id
                        })
        return agent_results
    
    def _create_sources(self, session, question_id: str, sources: List[str], timestamp: str):
        for i, source in enumerate(sources):
            source_id = f"source_{question_id}_{i}"
            session.run("""
                CREATE (s:Source {
                    id: $source_id,
                    content: $source,
                    timestamp: $timestamp,
                    order: $order
                })
            """, {
                "source_id": source_id,
                "source": source,
                "timestamp": timestamp,
                "order": i
            })
            
            session.run("""
                MATCH (q:Question {id: $question_id})
                MATCH (s:Source {id: $source_id})
                CREATE (q)-[:HAS_SOURCE]->(s)
            """, {
                "question_id": question_id,
                "source_id": source_id
            })
    
    def _create_graph_data(self, session, question_id: str, orchestrator_id: str, agent_tasks: List[Dict[str, Any]], graph_data: Dict[str, Any], timestamp: str, retrieval_suffix: str = "", neo4j_agent_name: Optional[str] = None, task_id: Optional[str] = None, agent_results: Dict[str, str] = None):
        if not graph_data:
            return
            
        result_id = None
        if agent_results and task_id:
            if task_id.startswith("task_"):
                try:
                    task_index = int(task_id.split("_")[1])
                    for key, res_id in agent_results.items():
                        if key.endswith(f"_{task_index}"):
                            result_id = res_id
                            logger.info(f"Found matching result for {task_id}: {key} -> {res_id}")
                            break
                except (ValueError, IndexError):
                    logger.info(f"Could not parse task index from task_id: {task_id}")
        
        if not result_id and agent_results and neo4j_agent_name:
            for key, res_id in agent_results.items():
                if key.startswith(neo4j_agent_name):
                    result_id = res_id
                    logger.info(f"Fallback: Using first result for agent {neo4j_agent_name}: {key} -> {res_id}")
                    break
        if not result_id and agent_results:
            result_id = list(agent_results.values())[-1]
            logger.info(f"Last resort: Using last available result: {result_id}")
        
        graphrag_id = f"graphrag_{question_id}{retrieval_suffix}"
        session.run("""
            CREATE (g:GraphRAGRetrieval {
                id: $graphrag_id,
                timestamp: $timestamp,
                query: $query,
                answer: $answer,
                executed_cypher: $executed_cypher,
                retrieved_nodes_count: $retrieved_nodes_count,
                retrieved_relationships_count: $retrieved_relationships_count
            })
        """, {
            "graphrag_id": graphrag_id,
            "timestamp": timestamp,
            "query": graph_data.get('query', ''),
            "answer": graph_data.get('answer', ''),
            "executed_cypher": graph_data.get('executed_cypher', ''),
            "retrieved_nodes_count": len(graph_data.get('retrieved_nodes', [])),
            "retrieved_relationships_count": len(graph_data.get('retrieved_relationships', []))
        })

        if result_id:
            session.run("""
                MATCH (r:Result {id: $result_id})
                MATCH (g:GraphRAGRetrieval {id: $graphrag_id})
                CREATE (r)-[:USING_GRAPHRAG]->(g)
            """, {
                "result_id": result_id,
                "graphrag_id": graphrag_id
            })
        
        retrieved_nodes = graph_data.get('retrieved_nodes', [])
        entity_map = {}
        
        chunk_nodes = []
        entity_nodes = []  
        document_nodes = []
        other_nodes = []
        
        for node_data in retrieved_nodes:
            node_labels = node_data.get('labels', [])
            if 'Chunk' in node_labels:
                chunk_nodes.append(node_data)
            elif 'Document' in node_labels:
                document_nodes.append(node_data)
            elif any(label in ['Entity', '__Entity__'] for label in node_labels):
                entity_nodes.append(node_data)
            else:
                other_nodes.append(node_data)
        
        logger.info(f"GraphRAG Audit - Processing nodes:")
        logger.info(f"Document nodes: {len(document_nodes)}")
        logger.info(f"Chunk nodes: {len(chunk_nodes)}")
        logger.info(f"Entity nodes: {len(entity_nodes)}")
        logger.info(f"Other nodes: {len(other_nodes)} - {[n.get('labels', []) for n in other_nodes[:5]]}")
        
        all_nodes_to_process = retrieved_nodes
        
        for i, node_data in enumerate(all_nodes_to_process):
            node_element_id = node_data.get('elementId') or node_data.get('id', f'unknown_{i}')
            node_labels = node_data.get('labels', [])
            node_properties = node_data.get('properties', {})
            
            escaped_labels = []
            for label in node_labels:
                if ' ' in label:
                    escaped_labels.append(f'`{label}`')
                else:
                    escaped_labels.append(label)
            labels_str = ':'.join(escaped_labels) if escaped_labels else 'Entity'
            node_id = f"entity_{graphrag_id}_{i}"
            
            create_query = f"""
                CREATE (e:{labels_str} {{
                    audit_id: $node_id,
                    original_element_id: $node_element_id,
                    timestamp: $timestamp
            """
            
            params = {
                "node_id": node_id,
                "node_element_id": node_element_id,
                "timestamp": timestamp
            }
            
            for prop_key, prop_value in node_properties.items():
                if prop_key not in ['audit_id', 'original_element_id', 'timestamp']:
                    clean_prop_key = prop_key.replace('-', '_').replace(' ', '_')
                    create_query += f", {clean_prop_key}: ${clean_prop_key}"
                    params[clean_prop_key] = str(prop_value) if prop_value is not None else ""
            
            create_query += "})"
            
            try:
                session.run(create_query, params)
            except Exception as e:
                logger.info(f"Failed to create node {labels_str}: {e}")
                session.run("""
                    CREATE (e:Entity {
                        audit_id: $node_id,
                        original_element_id: $node_element_id,
                        timestamp: $timestamp,
                        original_labels: $original_labels
                    })
                """, {
                    "node_id": node_id,
                    "node_element_id": node_element_id,
                    "timestamp": timestamp,
                    "original_labels": str(node_labels)
                })
            
            session.run("""
                MATCH (g:GraphRAGRetrieval {id: $graphrag_id})
                MATCH (e {audit_id: $node_id})
                CREATE (g)-[:RETRIEVED_ENTITY]->(e)
            """, {
                "graphrag_id": graphrag_id,
                "node_id": node_id
            })
            
            entity_map[node_element_id] = node_id
        
        retrieved_relationships = graph_data.get('retrieved_relationships', [])
        
        logger.info(f"GraphRAG Audit - Processing {len(retrieved_relationships)} relationships")
        logger.info(f"Entity map has {len(entity_map)} entries")
        
        for node_list_name in ['entity_nodes', 'chunk_nodes', 'document_nodes']:
            node_list = graph_data.get(node_list_name, [])
            if node_list:
                logger.info(f"Found {len(node_list)} additional {node_list_name}")
                for i, node_data in enumerate(node_list):
                    node_element_id = node_data.get('elementId') or node_data.get('id')
                    if node_element_id and node_element_id not in entity_map:
                        node_labels = node_data.get('labels', [])
                        labels_str = ':'.join(node_labels) if node_labels else 'Entity'
                        additional_node_id = f"additional_{node_list_name}_{graphrag_id}_{i}"
                        
                        try:
                            escaped_labels = []
                            for label in node_labels:
                                if ' ' in label:
                                    escaped_labels.append(f'`{label}`')
                                else:
                                    escaped_labels.append(label)
                            labels_str = ':'.join(escaped_labels) if escaped_labels else 'Entity'
                            
                            create_query = f"CREATE (n:{labels_str} {{ audit_id: $node_id, original_element_id: $element_id, timestamp: $timestamp"
                            params = {
                                "node_id": additional_node_id,
                                "element_id": node_element_id,
                                "timestamp": timestamp
                            }
                            
                            node_properties = node_data.get('properties', {})
                            for prop_key, prop_value in node_properties.items():
                                if prop_key not in ['audit_id', 'original_element_id', 'timestamp']:
                                    clean_prop_key = prop_key.replace('-', '_').replace(' ', '_')
                                    create_query += f", {clean_prop_key}: ${clean_prop_key}"
                                    params[clean_prop_key] = str(prop_value) if prop_value is not None else ""
                            
                            create_query += "})"
                            session.run(create_query, params)
                            
                            session.run("""
                                MATCH (g:GraphRAGRetrieval {id: $graphrag_id})
                                MATCH (n {audit_id: $node_id})
                                CREATE (g)-[:RETRIEVED_ADDITIONAL]->(n)
                            """, {"graphrag_id": graphrag_id, "node_id": additional_node_id})
                            
                            entity_map[node_element_id] = additional_node_id
                            
                        except Exception as e:
                            logger.info(f"Failed to create additional {node_list_name} node: {e}")
        
        successful_relationships = 0
        failed_relationships = 0
        for i, rel_data in enumerate(retrieved_relationships):
            rel_element_id = rel_data.get('elementId') or rel_data.get('id', f'unknown_rel_{i}')
            rel_type = rel_data.get('type', 'RELATED_TO')
            rel_properties = rel_data.get('properties', {})
            
            start_node_id = rel_data.get('startNodeElementId') or rel_data.get('start_node', '')
            end_node_id = rel_data.get('endNodeElementId') or rel_data.get('end_node', '')
            
            start_audit_id = entity_map.get(start_node_id)
            end_audit_id = entity_map.get(end_node_id)
            
            if start_audit_id and end_audit_id:
                rel_props_str = ""
                params = {
                    "start_audit_id": start_audit_id,
                    "end_audit_id": end_audit_id,
                    "rel_element_id": rel_element_id,
                    "timestamp": timestamp
                }
                
                if rel_properties:
                    props_list = ["original_element_id: $rel_element_id", "timestamp: $timestamp"]
                    for prop_key, prop_value in rel_properties.items():
                        if prop_key not in ['original_element_id', 'timestamp']:
                            props_list.append(f"{prop_key}: ${prop_key}")
                            params[prop_key] = str(prop_value) if prop_value is not None else ""
                    rel_props_str = " { " + ", ".join(props_list) + " }"
                else:
                    rel_props_str = " { original_element_id: $rel_element_id, timestamp: $timestamp }"
                
                try:
                    session.run(f"""
                        MATCH (start {{audit_id: $start_audit_id}})
                        MATCH (end {{audit_id: $end_audit_id}})
                        CREATE (start)-[:{rel_type}{rel_props_str}]->(end)
                    """, params)
                    
                    successful_relationships += 1
                except Exception as e:
                    logger.info(f"Failed to create relationship {rel_type}: {e}")
                    failed_relationships += 1
            else:
                if not start_audit_id:
                    logger.info(f"Start node not found for ID: {start_node_id}")
                if not end_audit_id:
                    logger.info(f"End node not found for ID: {end_node_id}")
                failed_relationships += 1
        
        logger.info(f"Relationship creation summary: {successful_relationships} created, {failed_relationships} failed")
    
    def _create_sources(self, session, question_id: str, sources: List[str], timestamp: str):
        for i, source in enumerate(sources):
            source_id = f"source_{question_id}_{i}"
            
            if source.startswith('Source: '):
                url = source.replace('Source: ', '')
                try:
                    from urllib.parse import urlparse
                    parsed = urlparse(url)
                    domain = parsed.hostname
                    
                    session.run("""
                        MATCH (q:Question {id: $question_id})
                        CREATE (s:Source:WebSource {
                            id: $source_id,
                            url: $url,
                            domain: $domain,
                            raw_text: $raw_text,
                            timestamp: $timestamp
                        })
                        CREATE (q)-[:SOURCED_FROM]->(s)
                    """, {
                        "question_id": question_id,
                        "source_id": source_id,
                        "url": url,
                        "domain": domain,
                        "raw_text": source,
                        "timestamp": timestamp
                    })
                except:
                    session.run("""
                        MATCH (q:Question {id: $question_id})
                        CREATE (s:Source {
                            id: $source_id,
                            content: $content,
                            timestamp: $timestamp
                        })
                        CREATE (q)-[:SOURCED_FROM]->(s)
                    """, {
                        "question_id": question_id,
                        "source_id": source_id,
                        "content": source,
                        "timestamp": timestamp
                    })
            else:
                session.run("""
                    MATCH (q:Question {id: $question_id})
                    CREATE (s:Source {
                        id: $source_id,
                        content: $content,
                        timestamp: $timestamp
                    })
                    CREATE (q)-[:SOURCED_FROM]->(s)
                """, {
                    "question_id": question_id,
                    "source_id": source_id,
                    "content": source,
                    "timestamp": timestamp
                })
    
    def get_session_history(self, session_id: str, limit: int = 50) -> List[Dict[str, Any]]:
        if not self.driver:
            return []
            
        try:
            with self.driver.session(database=self.database) as neo4j_session:
                result = neo4j_session.run("""
                    MATCH (s:Session {id: $session_id})-[:ASKED]->(q:Question)
                    OPTIONAL MATCH (q)<-[:FOR_QUESTION]-(t:Task)<-[:ASSIGNED_TASK]-(a:Agent)
                    RETURN q, collect(DISTINCT {agent: a.name, task: t.description, status: t.status}) as tasks
                    ORDER BY q.timestamp DESC
                    LIMIT $limit
                """, {"session_id": session_id, "limit": limit})
                
                questions = []
                for record in result:
                    question = dict(record['q'])
                    question['tasks'] = record['tasks']
                    questions.append(question)
                
                return questions
        except Exception as e:
            logger.error(f"Failed to get session history: {e}")
            return []
    
    def get_agent_stats(self, days: int = 30) -> Dict[str, Any]:
        if not self.driver:
            return {}
            
        try:
            with self.driver.session(database=self.database) as neo4j_session:
                result = neo4j_session.run("""
                    MATCH (a:Agent)-[:ASSIGNED_TASK]->(t:Task)-[:FOR_QUESTION]->(q:Question)
                    WHERE q.timestamp > datetime() - duration({days: $days})
                    RETURN a.name as agent_name, 
                           count(t) as tasks_count,
                           count(CASE WHEN t.status = 'completed' THEN 1 END) as completed_tasks,
                           count(CASE WHEN t.status = 'failed' THEN 1 END) as failed_tasks,
                           avg(toFloat(t.progress)) as avg_progress
                    ORDER BY tasks_count DESC
                """, {"days": days})
                
                stats = {}
                for record in result:
                    stats[record['agent_name']] = {
                        'tasks_count': record['tasks_count'],
                        'completed_tasks': record['completed_tasks'],
                        'failed_tasks': record['failed_tasks'],
                        'avg_progress': record['avg_progress']
                    }
                
                return stats
        except Exception as e:
            logger.error(f"Failed to get agent stats: {e}")
            return {}
    
    def close(self):
        if self.driver:
            self.driver.close()
