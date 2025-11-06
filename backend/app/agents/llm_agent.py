import os
from typing import Dict, Any, List
from openai import OpenAI
from datetime import datetime
from dotenv import load_dotenv
from langchain_core.messages import AIMessage

load_dotenv()

import logging
logger = logging.getLogger(__name__)

class LLMAgent:
    def __init__(self):
        self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        self.model = os.getenv("LLM_MODEL", "gpt-4o")
        self.fallback_model = "gpt-4o-mini"
        self.name = "LLM Agent"
        self.description = "AI research agent using GPT-5 for knowledge and analysis tasks"
        
    def search(self, query: str, context: str = "") -> str:
        try:
            full_prompt = f"""You are an expert research agent with access to comprehensive knowledge.
Your task is to provide detailed, accurate, and well-structured research responses.

INSTRUCTIONS:
- Provide factual, comprehensive information based on your knowledge
- Include specific details, examples, and explanations when relevant
- Structure your response clearly with sections if appropriate
- If discussing technical topics, explain both concepts and practical applications
- Be thorough but concise
- Focus on accuracy and relevance to the specific query
- If you're uncertain about recent developments, acknowledge this limitation
- NEVER generate JSON with JavaScript comments (/* ... */) - this creates invalid JSON
- If you need to create charts or data structures, use valid JSON format without comments
- When referencing data structures, use placeholder values instead of comments

Research Query: {query}

{f"Additional Context: {context}" if context else ""}

Please provide comprehensive research on this topic, including:
1. Core concepts and definitions
2. Key features or characteristics
3. Practical applications or use cases
4. Important considerations or limitations
5. Current state or recent developments (if applicable)

Structure your response clearly and focus on accuracy and usefulness."""

            query_str = str(query) 
            logger.info(f"Making GPT-5 API call for query: {query_str[:100]}...")
            
            result = None
            model_used = self.model
            
            try:
                response = self.client.responses.create(
                    model=self.model,
                    input=full_prompt,
                    text={}
                )
                if response.output and len(response.output) > 0:
                    for item in response.output:
                        if hasattr(item, 'content') and item.content:
                            for content_item in item.content:
                                if hasattr(content_item, 'text'):
                                    result = content_item.text
                                    break
                            if result:
                                break
                
                logger.info(f"gpt5 API response length: {len(result) if result else 0} characters")
                if not result or result.strip() == "":
                    logger.info("gpt5 returned empty response, trying gpt4 fallback...")
                    response = self.client.chat.completions.create(
                        model=self.fallback_model,
                        messages=[
                            {"role": "user", "content": full_prompt}
                        ],
                        max_tokens=2000,
                    )
                    result = response.choices[0].message.content
                    model_used = self.fallback_model
                    logger.info(f"gpt4 fallback response length: {len(result) if result else 0} characters")
                    
            except Exception as api_error:
                logger.error(f"gpt5 model failed, trying gpt4 fallback: {api_error}")
                try:
                    response = self.client.chat.completions.create(
                        model=self.fallback_model,
                        messages=[
                            {"role": "user", "content": full_prompt}
                        ],
                        max_tokens=2000,
                    )
                    result = response.choices[0].message.content
                    model_used = self.fallback_model
                    logger.info(f"gpt4 fallback response length: {len(result) if result else 0} characters")
                except Exception as fallback_error:
                    raise Exception(f"Both models failed - GPT-5: {api_error}, GPT-4: {fallback_error}")

            logger.info(f"Using model: {model_used}")
            logger.info(f"API response preview: {result[:200] if result else 'None'}...")
            
            if not result or result.strip() == "":
                result = f"Both gpt5 and gpt4 returned empty responses"
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            research_result = f"""**LLM Research Results** (Generated: {timestamp})

{result}

---
*Research provided by {model_used}*
"""

            logger.info(f"Final research_result length: {len(research_result)} characters")
            return research_result
            
        except Exception as e:
            error_msg = f"LLM Agent Error: {str(e)}"
            logger.error(f"LLM Agent search failed: {e}")
            return error_msg
    
    def invoke(self, input_data: Any, **kwargs) -> Dict[str, Any]:
        try:
            query = ""
            context = kwargs.get('context', '')
            
            if isinstance(input_data, str):
                query = input_data
            elif isinstance(input_data, dict):
                if 'messages' in input_data and input_data['messages']:
                    last_message = input_data['messages'][-1]
                    if hasattr(last_message, 'content'):
                        query = last_message.content
                    elif isinstance(last_message, dict) and 'content' in last_message:
                        query = last_message['content']
                    else:
                        query = str(last_message)
                else:
                    query = str(input_data)
            else:
                query = str(input_data)
            
            logger.info(f"LLM Agent extracted query: {query[:100] if query else 'Empty'}...")
            result = self.search(query, context)
            try:
                return {
                    "messages": [
                        AIMessage(content=result)
                    ]
                }
            except ImportError:
                return {
                    "messages": [
                        {"role": "assistant", "content": result, "type": "ai_message"}
                    ]
                }
            
        except Exception as e:
            error_msg = f"LLM Agent execution failed: {str(e)}"
            logger.info(f"LLM Agent invoke failed: {e}")
            
            try:
                return {
                    "messages": [
                        AIMessage(content=error_msg)
                    ]
                }
            except ImportError:
                return {
                    "messages": [
                        {"role": "assistant", "content": error_msg, "type": "ai_message"}
                    ]
                }

    def __call__(self, input_data: Any, **kwargs) -> Dict[str, Any]:
        return self.invoke(input_data, **kwargs)

def create_llm_research_tool():
    agent = LLMAgent()
    
    def llm_research(query: str) -> str:
        return agent.search(query)
    
    return llm_research


def llm_search(query: str, context: str = "") -> str:
    agent = LLMAgent()
    return agent.search(query, context)
