from typing import List
from models import Agent

def get_default_agents() -> List[Agent]:
    return [
        Agent(
            id="llm_agent",
            name="LLM Agent",
            color="#3F51B5",
            tools=["gpt5_search"],
            isEnabled=True,
            description="AI-powered search, research and analysis using GPT-5",
            priority=2,
        ),
        Agent(
            id="neo4j_agent",
            name="Neo4j Agent",
            color="#F44336",
            tools=["graphrag_search"],
            isEnabled=True,
            description="Specialized in Neo4j GraphRAG knowledge graph queries and analysis",
            priority=6,
        ),
    ]
