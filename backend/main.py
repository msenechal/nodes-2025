import os
import json
from datetime import datetime
from typing import Dict, List, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
from dotenv import load_dotenv
import logging
import asyncio
import traceback
import uvicorn

from models import (
    Agent, ChatRequest, ChatResponse
)
from app.config.agents import get_default_agents
from app.orchestrator.orchestrator import MultiAgentOrchestrator
from app.audit.neo4j_audit import Neo4jAuditLogger
from app.websocket.connection_manager import ConnectionManager
import time
load_dotenv()

formatter = logging.Formatter("%(asctime)s  -  %(name)s  -  %(levelname)s:  %(message)s")
timestamp = time.strftime("%H:%M:%S.%f")[:-3]

logging.basicConfig(level=logging.INFO, format=formatter._fmt)
logger = logging.getLogger(__name__)

manager = ConnectionManager()

orchestrator: Optional[MultiAgentOrchestrator] = None
audit_logger: Optional[Neo4jAuditLogger] = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global orchestrator, audit_logger
    logger.info("Starting...")
    
    openai_api_key = os.getenv("OPENAI_API_KEY")
    neo4j_uri = os.getenv("NEO4J_URI")
    neo4j_username = os.getenv("NEO4J_USERNAME")
    neo4j_password = os.getenv("NEO4J_PASSWORD")
    
    neo4j_audit_uri = os.getenv("NEO4J_AUDIT_URI")
    neo4j_audit_username = os.getenv("NEO4J_AUDIT_USERNAME")
    neo4j_audit_password = os.getenv("NEO4J_AUDIT_PASSWORD")
    
    check_envs = [var for var in ['OPENAI_API_KEY', 'NEO4J_URI', 'NEO4J_USERNAME', 'NEO4J_PASSWORD', 'NEO4J_AUDIT_URI', 'NEO4J_AUDIT_USERNAME', 'NEO4J_AUDIT_PASSWORD'] 
                      if not os.environ.get(var)]
    if check_envs:
        logger.error(f"Missing environment variables: {', '.join(check_envs)}")
    else:
        logger.info("All Env variables loaded.")
    
    try:
        audit_logger = Neo4jAuditLogger(
            uri=neo4j_audit_uri,
            username=neo4j_audit_username,
            password=neo4j_audit_password
        )
        if audit_logger.driver:
            logger.info("Neo4j Audit initialized successfully")
        else:
            logger.warning("Neo4j Audit disabled (audit won't be available)")
    except Exception as e:
        logger.error(f"Failed to initialize Neo4j Audit: {e}")
        audit_logger = None
        
    try:
        orchestrator = MultiAgentOrchestrator(
            openai_api_key=openai_api_key,
            neo4j_uri=neo4j_uri,
            neo4j_username=neo4j_username,
            neo4j_password=neo4j_password,
            connection_manager=manager
        )
        logger.info("Multi-Agent Orchestrator initialized successfully")
    except Exception as e:
        logger.error(f"Failed to initialize Multi-Agent Orchestrator: {e}")
    
    yield
    
    logger.info("Shutting down Multi-Agent Backend...")
    if audit_logger:
        audit_logger.close()
        logger.info("Audit logger closed")

app = FastAPI(
    title="Multi-Agent Chat Backend",
    description="Multi-agent backend",
    version="1.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("FRONTEND_URL", "http://localhost:5173")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def root():
    return {
        "message": "Multi-Agent Backend is running",
        "status": "healthy",
        "orchestrator": orchestrator is not None
    }

@app.get("/health")
async def health():
    return {
        "status": "healthy", 
        "orchestrator": orchestrator is not None,
        "message": "Backend is operational" if orchestrator else "Backend running but orchestrator not initialized"
    }

@app.get("/agents")
async def get_agents():
    return {"agents": get_default_agents()}

@app.post("/chat", response_model=ChatResponse)
async def chat_endpoint(request: ChatRequest):
    global orchestrator, audit_logger
    
    if not orchestrator:
        return ChatResponse(
            response="Multi-agent system is not available.",
            src=[],
            agentTasks=[]
        )
    
    try:
        agents = request.agents if request.agents else get_default_agents()
        
        if orchestrator and agents:
            orchestrator.update_agent_configs(agents)
        
        def run_orchestrator_sync():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                conversation_history = None
                if request.conversationHistory:
                    conversation_history = [
                        {
                            'role': msg.role,
                            'content': msg.content,
                            'timestamp': msg.timestamp
                        } for msg in request.conversationHistory
                    ]
                
                return loop.run_until_complete(
                    orchestrator.process_query(
                        request.message, 
                        session_id=request.sessionId,
                        conversation_history=conversation_history
                    )
                )
            finally:
                loop.close()
        
        result = await asyncio.to_thread(run_orchestrator_sync)
        
        if audit_logger:
            try:
                sources = result.src if hasattr(result, 'src') else []
                
                graph_retrievals = []
                for task in (result.agentTasks or []):
                    gd = None
                    if hasattr(task, 'graph_data') and task.graph_data:
                        gd = task.graph_data
                    elif hasattr(task, 'graphData') and task.graphData:
                        gd = task.graphData

                    if gd:
                        logger.info(f"Found GraphRAG data in task {task.agentName} (task id={task.id})")
                        graph_retrievals.append({
                            'agent_name': task.agentName,
                            'task_id': task.id,
                            'graph_data': gd
                        })

                agents_used = [task.agentName for task in (result.agentTasks or [])]

                audit_logger.log_question_workflow(
                    session_id=request.sessionId,
                    question=request.message,
                    agent_tasks=[{
                        'agent': task.agentName,
                        'type': task.agentName,
                        'task': task.task,
                        'input': task.input,
                        'result': task.result,
                        'status': task.status.value if hasattr(task.status, 'value') else str(task.status),
                        'startTime': task.startTime,
                        'endTime': task.endTime,
                        'error': task.error,
                        'progress': task.progress
                    } for task in (result.agentTasks or [])],
                    response=result.response,
                    agents_used=agents_used,
                    processing_time=getattr(result, 'processing_time', 0.0),
                    sources=sources,
                    graph_data=graph_retrievals,
                    model=os.getenv("LLM_MODEL"),
                    is_multi_agent=request.isMultiAgentMode
                )
                logger.info(f"Logged question workflow to audit database with GraphRAG data: {'Yes' if graph_retrievals else 'No'}")
            except Exception as e:
                logger.error(f"Failed to log to audit database: {e}")
                traceback.print_exc()
        
        return ChatResponse(
            response=result.response,
            src=result.agents_used,
            agentTasks=result.agentTasks,
        )
        
    except Exception as e:
        logger.error(f"Error in chat endpoint: {str(e)}")
        return ChatResponse(
            response=f"I encountered an error while processing your request: {str(e)}. Please try again or check the server logs for more details.",
            src=[],
            agentTasks=[]
        )

@app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    await manager.connect(websocket, session_id)
    
    test_message = {
        "type": "connection_test",
        "sessionId": session_id,
        "timestamp": datetime.now().strftime("%H:%M:%S.%f")[:-3],
        "message": "WebSocket connection established"
    }
    try:
        await websocket.send_text(json.dumps(test_message))
        logger.info(f"Sent connection test message to {session_id}")
    except Exception as e:
        logger.error(f"Failed to send test message to {session_id}: {e}")
    
    try:
        while True:
            data = await websocket.receive_text()
            await websocket.send_text(f"Session {session_id} connected")
    except WebSocketDisconnect:
        manager.disconnect(session_id)
    except Exception as e:
        logger.error(f"WebSocket error for session {session_id}: {str(e)}")
        manager.disconnect(session_id)

@app.get("/neo4j/schema")
async def get_neo4j_schema():
    try:
        if hasattr(orchestrator, 'neo4j_graphrag') and orchestrator.neo4j_graphrag:
            schema_info = orchestrator.neo4j_graphrag.get_database_schema()
            return JSONResponse(content=schema_info)
        else:
            return JSONResponse(
                status_code=503,
                content={"error": "Neo4j GraphRAG agent not available"}
            )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": f"Failed to get schema: {str(e)}"}
        )

@app.get("/audit/health")
async def get_audit_health():
    global audit_logger
    
    if not audit_logger:
        return JSONResponse(content={
            "status": "disabled",
            "message": "Audit logger not initialized"
        })
    
    if not audit_logger.driver:
        return JSONResponse(content={
            "status": "disconnected", 
            "message": "Audit database not connected"
        })
    
    try:
        audit_logger.driver.verify_connectivity()
        return JSONResponse(content={
            "status": "healthy",
            "message": "Audit database connected and operational"
        })
    except Exception as e:
        return JSONResponse(content={
            "status": "error",
            "message": f"Audit database connection error: {str(e)}"
        })

if __name__ == "__main__":
    port = int(os.getenv("BACKEND_PORT", 8000))
    uvicorn.run(
        "main:app", 
        host="0.0.0.0", 
        port=port, 
        reload=True,
        log_level="info"
    )
