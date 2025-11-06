import os
import logging
from typing import List, Dict, Any, Optional
import neo4j
from neo4j import GraphDatabase
from neo4j_graphrag.generation import GraphRAG
from neo4j_graphrag.retrievers import VectorCypherRetriever
from neo4j_graphrag.llm import OpenAILLM
from neo4j_graphrag.embeddings.openai import OpenAIEmbeddings
from neo4j_graphrag.types import RetrieverResultItem

logger = logging.getLogger(__name__)

class Neo4jGraphRAGAgent:
    def __init__(self, uri: str, username: str, password: str, openai_api_key: str):
        self.driver = GraphDatabase.driver(uri, auth=(username, password), notifications_min_severity='WARNING')
        self.database = os.getenv("NEO4J_DATABASE", "neo4j") 
        
        try:
            self.driver.verify_connectivity()
            logger.info(f"Neo4j connection established successfully (database: {self.database})")
        except Exception as e:
            logger.error(f"Neo4j connection failed: {e}")
            raise

        try:
            self.llm = OpenAILLM(
                model_name=os.getenv("LLM_MODEL", "gpt-4o-mini"),
                api_key=openai_api_key
            )
            self.embedder = OpenAIEmbeddings(
                model="text-embedding-ada-002",
                api_key=openai_api_key
            )
            logger.info("OpenAI LLM and embeddings initialized")
        except Exception as e:
            logger.error(f"Failed to initialize LLM/embeddings: {e}")
            raise
        
        try:
            vector_index_name = os.getenv("VECTOR_INDEX_NAME", "vectorIndex")
            
            retrieval_query = """
            with node, score 
            OPTIONAL MATCH (node)-[]-(e:!Chunk&!Document) 
            return collect(elementId(node))+collect(elementId(e)) as listIds, 
            collect(e) as contextNodes, node.plot as nodeText, score
            """
            
            self.retriever = VectorCypherRetriever(
                driver=self.driver,
                index_name=vector_index_name,
                retrieval_query=retrieval_query,
                result_formatter=self._format_retriever_result,
                embedder=self.embedder,
                neo4j_database=self.database,
            )
            logger.info(f"VectorCypherRetriever initialized with index: {vector_index_name}")
        except Exception as e:
            logger.error(f"Failed to initialize retriever: {e}")
            raise
        
        try:
            self.graphrag = GraphRAG(
                retriever=self.retriever,
                llm=self.llm
            )
            logger.info("Neo4j GraphRAG initialized successfully")
        except Exception as e:
            logger.error(f"Neo4j GraphRAG initialization failed: {e}")
            raise
    
    def _format_retriever_result(self, record: neo4j.Record) -> RetrieverResultItem:
        node_text = record.get("nodeText")
        score = record.get("score")
        list_ids = record.get("listIds")
        context_nodes = record.get("contextNodes")

        return RetrieverResultItem(
            content=f"{node_text}", 
            metadata={
                "listIds": list_ids,
                "nodeText": node_text,
                "contextNodes": context_nodes,
                "score": score
            }
        )
    
    def close(self):
        self.driver.close()
    
    def search(self, query: str) -> str:
        try:
            result = self.graphrag.search(query_text=query, return_context=True)
            return result.answer
        except Exception as e:
            logger.error(f"GraphRAG search error: {e}")
            return f"Search error: {str(e)[:100]}"
    
    def search_with_context(self, query: str) -> Dict[str, Any]:
        try:
            result = self.graphrag.search(query_text=query, return_context=True)
            
            context_data = {
                'answer': result.answer,
                'chunk_nodes': [],
                'entity_nodes': [],
                'document_nodes': [],
                'retrieved_nodes': [],
                'retrieved_relationships': [],
                'query': query,
                'executed_cypher': 'No cypher available'
            }
            
            all_list_ids = []
            if hasattr(result, 'retriever_result') and result.retriever_result:
                for item in result.retriever_result.items:
                    if hasattr(item, 'metadata') and item.metadata:
                        list_ids = item.metadata.get('listIds', [])
                        flattened_ids = self._flatten_list(list_ids)
                        all_list_ids.extend(flattened_ids)
            
            unique_list_ids = list(set(all_list_ids))
            if unique_list_ids:
                retrieved_graph_data = self._get_retrieved_graph_data(unique_list_ids)

                executed_cypher = f"""MATCH (a:Movie) WHERE elementId(a) in {unique_list_ids}
OPTIONAL MATCH (a)-[r]-(b)
WHERE elementId(b) IN {unique_list_ids}
RETURN a, r, b LIMIT 1000"""

                retrieved_graph_data["executed_cypher"] = executed_cypher
                context_data.update(retrieved_graph_data)
            
            return context_data
            
        except Exception as e:
            logger.error(f"GraphRAG search with context error: {e}")
            return {
                'answer': f"Search error: {str(e)[:100]}",
                'chunk_nodes': [],
                'entity_nodes': [],
                'document_nodes': [],
                'retrieved_nodes': [],
                'retrieved_relationships': [],
                'query': query,
                'executed_cypher': f'Error occurred during search: {str(e)[:100]}'
            }
    
    def _flatten_list(self, nested_list):
        flattened = []
        if isinstance(nested_list, list):
            for item in nested_list:
                if isinstance(item, list):
                    flattened.extend(self._flatten_list(item))
                else:
                    flattened.append(item)
        else:
            flattened.append(nested_list)
        return flattened
    
    def _serialize_neo4j_value(self, value):
        if hasattr(value, '__class__') and 'neo4j' in str(type(value)):
            return str(value)
        elif isinstance(value, dict):
            return {k: self._serialize_neo4j_value(v) for k, v in value.items()}
        elif isinstance(value, list):
            return [self._serialize_neo4j_value(item) for item in value]
        else:
            return value
    
    def _get_retrieved_graph_data(self, list_ids: List[str]) -> Dict[str, Any]:
        logger.info(f"Getting retrieved graph data for {len(list_ids)} chunk/document IDs")
        logger.info(f"Chunk IDs: {list_ids}")
        
        try:
            with self.driver.session(database=self.database) as session:
                formatted_sources = ', '.join([f"'{source}'" for source in list_ids])
                
                retrieval_query = f"""
                MATCH (a:Movie) WHERE elementId(a) in [{formatted_sources}]
                OPTIONAL MATCH (a)-[r]-(b)
                WHERE elementId(b) IN [{formatted_sources}]
                RETURN a, r, b
                LIMIT 1000
                """
                
                result = session.run(retrieval_query)
                
                retrieved_nodes = []
                retrieved_relationships = []
                processed_nodes = set()
                processed_relationships = set()
                
                record_count = 0
                for record in result:
                    record_count += 1
                    
                    for node_key in ['a', 'b', 'd']:
                        node = record.get(node_key)
                        if not node:
                            logger.info(f"Skipping missing node for key '{node_key}' in record {record_count}")
                            continue
                        if not hasattr(node, 'element_id'):
                            logger.info(f"Skipping node without element_id for key '{node_key}' in record {record_count}")
                            continue
                        if node.element_id in processed_nodes:
                            continue

                        try:
                            node_labels = list(node.labels)
                            node_props = self._serialize_neo4j_value(dict(node))
                            if isinstance(node_props, dict) and 'embedding' in node_props:
                                node_props['embedding'] = None

                            retrieved_nodes.append({
                                'id': node.element_id,
                                'labels': node_labels,
                                'properties': node_props,
                                'type': node_labels[0] if node_labels else 'Node'
                            })
                            processed_nodes.add(node.element_id)
                        except Exception as node_err:
                            logger.info(f"Error processing node for key '{node_key}': {node_err}")
                    
                    for rel_key in ['r', 'r2']:
                        relationship = record.get(rel_key)
                        if not hasattr(relationship, 'element_id'):
                            logger.info(f"Skipping relationship without element_id for key '{rel_key}' in record {record_count}")
                            continue

                        try:
                            start_id = getattr(relationship.start_node, 'element_id', None)
                            end_id = getattr(relationship.end_node, 'element_id', None)
                            rel_unique_key = f"{relationship.element_id}:{getattr(relationship, 'type', 'UNKNOWN')}:{start_id}:{end_id}"

                            if rel_unique_key in processed_relationships:
                                continue

                            rel_props = self._serialize_neo4j_value(dict(relationship))
                            retrieved_relationships.append({
                                'id': relationship.element_id,
                                'type': getattr(relationship, 'type', 'UNKNOWN'),
                                'start_node': start_id,
                                'end_node': end_id,
                                'properties': rel_props
                            })
                            processed_relationships.add(rel_unique_key)
                        except Exception as rel_err:
                            logger.info(f"Error processing relationship for key '{rel_key}': {rel_err}")
                
                logger.info(f"Final counts: {len(retrieved_nodes)} nodes, {len(retrieved_relationships)} relationships")
                return {
                    'retrieved_nodes': retrieved_nodes,
                    'retrieved_relationships': retrieved_relationships,
                    'total_retrieved_nodes': len(retrieved_nodes),
                    'total_retrieved_relationships': len(retrieved_relationships)
                }
                
        except Exception as e:
            logger.info(f"Error getting retrieved graph data: {e}")
            return {
                'retrieved_nodes': [],
                'retrieved_relationships': [],
                'total_retrieved_nodes': 0,
                'total_retrieved_relationships': 0,
                'error': str(e)[:100]
            }
    
    def get_database_schema(self) -> Dict[str, Any]:
        try:
            with self.driver.session(database=self.database) as session:
                rel_types_result = session.run("CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType")
                relationship_types = [record['relationshipType'] for record in rel_types_result]
                
                labels_result = session.run("CALL db.labels() YIELD label RETURN label")
                node_labels = [record['label'] for record in labels_result]
                
                patterns_result = session.run("""
                MATCH (a)-[r]->(b) 
                RETURN DISTINCT labels(a)[0] as from_label, type(r) as rel_type, labels(b)[0] as to_label, count(*) as count 
                ORDER BY count DESC LIMIT 20
                """)
                
                relationship_patterns = []
                for record in patterns_result:
                    relationship_patterns.append({
                        'from': record['from_label'],
                        'relationship': record['rel_type'],
                        'to': record['to_label'],
                        'count': record['count']
                    })
                
                return {
                    'node_labels': node_labels,
                    'relationship_types': relationship_types,
                    'relationship_patterns': relationship_patterns
                }
        except Exception as e:
            logger.error(f"Error getting database schema: {e}")
            return {
                'node_labels': [],
                'relationship_types': [],
                'relationship_patterns': [],
                'error': str(e)[:100]
            }
