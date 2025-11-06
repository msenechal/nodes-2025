import json
from typing import Dict
from fastapi import WebSocket
import logging
logger = logging.getLogger(__name__)

from models import TaskUpdate, MultiTaskUpdate

class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}

    async def connect(self, websocket: WebSocket, session_id: str):
        logger.info(f"WebSocket connection request for session: {session_id}")
        await websocket.accept()
        self.active_connections[session_id] = websocket
        logger.info(f"WebSocket connected for session: {session_id}")
        logger.info(f"Active connections: {list(self.active_connections.keys())}")

    def disconnect(self, session_id: str):
        if session_id in self.active_connections:
            del self.active_connections[session_id]

    async def send_task_update(self, session_id: str, task_update: TaskUpdate):
        if session_id in self.active_connections:
            try:
                await self.active_connections[session_id].send_text(
                    task_update.model_dump_json()
                )
            except Exception:
                self.disconnect(session_id)

    async def send_multi_task_update(self, session_id: str, multi_task_update: MultiTaskUpdate):
        logger.info(f"ConnectionManager.send_multi_task_update called:")
        logger.info(f"session_id: {session_id}")
        logger.info(f"active_connections: {list(self.active_connections.keys())}")
        logger.info(f"session in connections: {session_id in self.active_connections}")
        
        if session_id in self.active_connections:
            try:
                message_json = multi_task_update.model_dump_json()
                logger.info(f"Sending WebSocket message:")
                logger.info(f"message length: {len(message_json)} chars")
                logger.info(f"message preview: {message_json[:200]}...")
                
                await self.active_connections[session_id].send_text(message_json)
                logger.info(f"WebSocket message sent successfully to {session_id}")
            except Exception as e:
                logger.info(f"Error sending WebSocket message: {e}")
                self.disconnect(session_id)
        else:
            logger.info(f"Session {session_id} not found in active connections")
            logger.info(f"Available sessions: {list(self.active_connections.keys())}")

    async def send_json_message(self, session_id: str, message_dict: dict):
        logger.info(f"ConnectionManager.send_json_message called:")
        logger.info(f"session_id: {session_id}")
        logger.info(f"message_type: {message_dict.get('type', 'unknown')}")
        
        if session_id in self.active_connections:
            try:
                message_json = json.dumps(message_dict)
                logger.info(f"Sending generic WebSocket message:")
                logger.info(f"message: {message_json}")
                
                await self.active_connections[session_id].send_text(message_json)
                logger.info(f"Generic WebSocket message sent successfully to {session_id}")
            except Exception as e:
                logger.info(f"Error sending generic WebSocket message: {e}")
                self.disconnect(session_id)
        else:
            logger.info(f"Session {session_id} not found in active connections")