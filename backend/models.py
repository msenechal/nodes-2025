from typing import Dict, Any, List, Optional
from pydantic import BaseModel
from enum import Enum

class AgentStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"

class AgentTask(BaseModel):
    id: str
    agentId: str
    agentName: str
    agentColor: str
    task: str
    status: AgentStatus
    startTime: Optional[int] = None
    endTime: Optional[int] = None
    result: Optional[str] = None
    error: Optional[str] = None
    progress: Optional[int] = None
    input: Optional[str] = None
    graphData: Optional[Dict[str, Any]] = None

class Agent(BaseModel):
    id: str
    name: str
    color: str
    tools: List[str]
    isEnabled: bool
    description: str
    priority: int = 0

class ChatMessage(BaseModel):
    id: int
    user: str
    message: str
    datetime: str
    isTyping: Optional[bool] = False
    src: Optional[List[str]] = []
    agentTasks: Optional[List[AgentTask]] = []
    userQuery: Optional[str] = None

class ConversationMessage(BaseModel):
    role: str
    content: str
    timestamp: Optional[str] = None

class ChatRequest(BaseModel):
    message: str
    sessionId: str
    agents: Optional[List[Agent]] = []
    isMultiAgentMode: bool = True
    conversationHistory: Optional[List[ConversationMessage]] = []

class ChatResponse(BaseModel):
    response: str
    src: List[str]
    agentTasks: Optional[List[AgentTask]] = []
    sessionTitle: Optional[str] = None

class TaskUpdate(BaseModel):
    type: str = "task_update"
    sessionId: str
    task: AgentTask

class MultiTaskUpdate(BaseModel):
    type: str = "multi_task_update"
    sessionId: str
    tasks: List[AgentTask]

class MultiAgentResponse(BaseModel):
    query: str
    response: str
    agents_used: List[str]
    processing_time: float
    synthesis_applied: bool
    src: Optional[List[str]] = []
    agentTasks: Optional[List[AgentTask]] = []
    totalTime: Optional[int] = None
    sessionTitle: Optional[str] = None
