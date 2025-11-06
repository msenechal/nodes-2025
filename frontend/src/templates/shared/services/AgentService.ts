import { Agent, Tool, AgentTask, MultiAgentResponse } from '../types/Agent';

const BACKEND_URL = process.env.NODE_ENV === 'development' ? '/api' : 'http://localhost:8000';
const WS_URL = process.env.NODE_ENV === 'development' ? 'ws://localhost:5173/ws' : 'ws://localhost:8000/ws';

class WebSocketManager {
  private connections = new Map<string, WebSocket>();
  private callbacks = new Map<string, (tasks: AgentTask[]) => void>();
  private sessionTitleCallbacks = new Map<string, (sessionId: string, title: string) => void>();

  connect(sessionId: string, onTaskUpdate: (tasks: AgentTask[]) => void): Promise<void> {
    const timestamp = () => new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + String(new Date().getMilliseconds()).padStart(3, '0');
    
    return new Promise((resolve, reject) => {
      if (this.connections.has(sessionId)) {
        this.disconnect(sessionId);
      }

      try {
        const wsUrl = `${WS_URL}/${sessionId}`;
        const ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
          resolve();
        };

        ws.onmessage = (event) => {
          const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + String(new Date().getMilliseconds()).padStart(3, '0');
          try {
            const data = JSON.parse(event.data);
            
            const callback = this.callbacks.get(sessionId);
            if (!callback) {
              return;
            }
            
            if (data.type === 'multi_task_update' && data.tasks) {
              callback(data.tasks);
            } else if (data.type === 'task_update' && data.task) {
              callback([data.task]);
            } else if (data.type === 'session_title_update' && data.sessionId && data.title) {
              const titleCallback = this.sessionTitleCallbacks.get(sessionId);
              if (titleCallback) {
                titleCallback(data.sessionId, data.title);
              } else {
                console.log(`[${ts}] No session title callback registered for session ${sessionId}`);
              }
            } else if (data.type === 'connection_test') {
              console.log(`[${ts}] Connection test message received: ${data.message}`);
            } else {
              console.log(`[${ts}] Unknown message format:`, data);
            }
          } catch (error) {
            console.error(`[${ts}] Error parsing WebSocket message:`, error);
            console.error(`[${ts}] - raw message:`, event.data);
          }
        };

        ws.onerror = (error) => {
          reject(error);
        };

        ws.onclose = () => {
          this.connections.delete(sessionId);
          this.callbacks.delete(sessionId);
        };

        this.connections.set(sessionId, ws);
        this.callbacks.set(sessionId, onTaskUpdate);
      } catch (error) {
        reject(error);
      }
    });
  }

  disconnect(sessionId: string) {
    const ws = this.connections.get(sessionId);
    if (ws) {
      ws.close();
      this.connections.delete(sessionId);
      this.callbacks.delete(sessionId);
      this.sessionTitleCallbacks.delete(sessionId);
    }
  }

  disconnectAll() {
    for (const sessionId of this.connections.keys()) {
      this.disconnect(sessionId);
    }
  }

  registerSessionTitleCallback(sessionId: string, callback: (sessionId: string, title: string) => void) {
    this.sessionTitleCallbacks.set(sessionId, callback);
  }

  unregisterSessionTitleCallback(sessionId: string) {
    this.sessionTitleCallbacks.delete(sessionId);
  }
}

const wsManager = new WebSocketManager();

export const webSocketManager = wsManager;

export const processMultiAgentQuery = async (
  query: string, 
  agents: Agent[],
  onTaskUpdate?: (tasks: AgentTask[]) => void,
  onSessionTitleUpdate?: (sessionId: string, title: string) => void,
  providedSessionId?: string,
  conversationHistory?: Array<{ role: string; content: string; timestamp?: string }>
): Promise<MultiAgentResponse> => {
  const startTime = Date.now();
  const sessionId = providedSessionId || `session-${Date.now()}`;

  if (onSessionTitleUpdate) {
    wsManager.registerSessionTitleCallback(sessionId, onSessionTitleUpdate);
  }

  const backendAvailable = await testBackendConnection();
  
  if (!backendAvailable) {
    return await processMultiAgentQueryMock(query, agents, onTaskUpdate, conversationHistory);
  }

  try {
    if (onTaskUpdate) {
      await wsManager.connect(sessionId, onTaskUpdate);
      await new Promise(resolve => setTimeout(resolve, 50));
    } else {
      console.log(`No onTaskUpdate callback provided - skipping WebSocket`);
    }

    const requestPayload = {
      message: query,
      sessionId: sessionId,
      isMultiAgentMode: true,
      conversationHistory: conversationHistory || [],
      agents: agents.filter(agent => agent.isEnabled).map(agent => ({
        id: agent.id,
        name: agent.name,
        color: agent.color,
        tools: agent.tools,
        isEnabled: agent.isEnabled,
        description: agent.description,
        priority: agent.priority || 0
      }))
    };

    const httpRequestPromise = fetch(`${BACKEND_URL}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestPayload),
    });
    
    const response = await httpRequestPromise;

    if (!response.ok) {
      throw new Error(`Backend error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    wsManager.disconnect(sessionId);
    
    if (onSessionTitleUpdate) {
      wsManager.unregisterSessionTitleCallback(sessionId);
    }

    return {
      response: data.response,
      src: data.src || [],
      agentTasks: data.agentTasks || [],
      totalTime: Date.now() - startTime,
      sessionTitle: data.sessionTitle,
    };

  } catch (error) {
    wsManager.disconnect(sessionId);
    if (onSessionTitleUpdate) {
      wsManager.unregisterSessionTitleCallback(sessionId);
    }
    return await processMultiAgentQueryMock(query, agents, onTaskUpdate, conversationHistory);
  }
};

const processMultiAgentQueryMock = async (
  query: string, 
  agents: Agent[],
  onTaskUpdate?: (tasks: AgentTask[]) => void,
  conversationHistory?: Array<{ role: string; content: string; timestamp?: string }>
): Promise<MultiAgentResponse> => {
  const startTime = Date.now();
  const initialTasks = assignTasksToAgents(query, agents);
  
  if (initialTasks.length === 0) {
    return {
      response: "No agents are available to process your request. Please configure at least one agent.",
      src: [],
      agentTasks: [],
      totalTime: Date.now() - startTime,
    };
  }

  let tasks: AgentTask[] = initialTasks.map(task => ({ ...task, status: 'pending' }));
  onTaskUpdate?.(tasks);

  const results: string[] = [];
  const sources: string[] = [];

  const maxConcurrent = Math.min(3, tasks.length);
  
  for (let i = 0; i < tasks.length; i += maxConcurrent) {
    const batch = tasks.slice(i, i + maxConcurrent);
    
    tasks = tasks.map(task => {
      if (batch.some(b => b.id === task.id)) {
        return { ...task, status: 'running' as const, startTime: Date.now(), progress: 0 };
      }
      return task;
    });
    onTaskUpdate?.(tasks);

    const batchPromises = batch.map(async (batchTask) => {
      try {
        const progressInterval = setInterval(() => {
          tasks = tasks.map(t => {
            if (t.id === batchTask.id && t.status === 'running') {
              return { ...t, progress: Math.min((t.progress || 0) + Math.random() * 15 + 5, 95) };
            }
            return t;
          });
          onTaskUpdate?.(tasks);
        }, 800);

        const agent = agents.find(a => a.id === batchTask.agentId);
        const tool = agent?.tools.find(t => batchTask.task.includes(t.type));
        
        const result = await mockToolExecution(tool?.id || 'unknown', query);
        
        clearInterval(progressInterval);
        
        tasks = tasks.map(t => {
          if (t.id === batchTask.id) {
            return { ...t, status: 'completed' as const, endTime: Date.now(), progress: 100, result };
          }
          return t;
        });
        onTaskUpdate?.(tasks);

        results.push(result);
        sources.push(`${batchTask.agentName}:${tool?.name || 'Unknown Tool'}`);
        
      } catch (error) {
        tasks = tasks.map(t => {
          if (t.id === batchTask.id) {
            return { ...t, status: 'failed' as const, endTime: Date.now(), error: String(error) };
          }
          return t;
        });
        onTaskUpdate?.(tasks);
      }
    });

    await Promise.all(batchPromises);
  }

  const response = generateFinalResponse(query, results);
  
  return {
    response,
    src: sources,
    agentTasks: tasks,
    totalTime: Date.now() - startTime,
  };
};

const mockToolExecution = async (toolId: string, query: string): Promise<string> => {
  await new Promise(resolve => setTimeout(resolve, Math.random() * 5000 + 5000));
  
  switch (toolId) {
    case 'web_search':
      return `Found ${Math.floor(Math.random() * 10) + 1} web results for "${query}"`;
    case 'database_query':
      return `Retrieved ${Math.floor(Math.random() * 50) + 1} records from Neo4j database`;
    case 'data_visualization':
      return `Created visualization with ${Math.floor(Math.random() * 100) + 1} data points`;
    case 'calculation':
      return `Calculated result: ${Math.floor(Math.random() * 1000) + 1}`;
    case 'document_analysis':
      return `Processed ${Math.floor(Math.random() * 5) + 1} documents successfully`;
    case 'code_generation':
      return `Generated code with ${Math.floor(Math.random() * 50) + 1} lines`;
    default:
      return `Completed task using ${toolId}`;
  }
};

const assignTasksToAgents = (query: string, agents: Agent[]): AgentTask[] => {
  const enabledAgents = agents.filter(agent => agent.isEnabled);
  if (enabledAgents.length === 0) {
    return [];
  }

  const tasks: AgentTask[] = [];
  
  const sortedAgents = [...enabledAgents].sort((a, b) => b.priority - a.priority);
  
  sortedAgents.forEach((agent, index) => {
    const relevantTools = agent.tools.filter(tool => {
      const queryLower = query.toLowerCase();
      switch (tool.type) {
        case 'web':
          return queryLower.includes('search') || queryLower.includes('find') || queryLower.includes('look') ||
                 queryLower.includes('information') || queryLower.includes('what') || queryLower.includes('who') ||
                 queryLower.includes('where') || queryLower.includes('when') || queryLower.includes('how') ||
                 queryLower.includes('why') || query.includes('?');
        case 'database':
          return queryLower.includes('data') || queryLower.includes('query') || queryLower.includes('records') ||
                 queryLower.includes('neo4j') || queryLower.includes('graph') || queryLower.includes('node') ||
                 queryLower.includes('relationship') || queryLower.includes('cypher') || query.includes('?');
        case 'api':
          return queryLower.includes('api') || queryLower.includes('service') || queryLower.includes('request') ||
                 queryLower.includes('external') || queryLower.includes('integration') || query.includes('?');
        case 'calculation':
          return queryLower.includes('calculate') || queryLower.includes('compute') || queryLower.includes('math') ||
                 queryLower.includes('number') || queryLower.includes('count') || queryLower.includes('sum') ||
                 queryLower.includes('average') || /\d/.test(query);
        case 'file':
          return queryLower.includes('file') || queryLower.includes('document') || queryLower.includes('read') ||
                 queryLower.includes('analyze') || queryLower.includes('content') || query.includes('?');
        default:
          return true;
      }
    });

    const toolsToAssign = relevantTools.length > 0 ? relevantTools : agent.tools.slice(0, 1);

    toolsToAssign.slice(0, 2).forEach((tool) => {
      tasks.push({
        id: `${agent.id}-${tool.id}-${Date.now() + index}`,
        agentId: agent.id,
        agentName: agent.name,
        agentColor: agent.color,
        task: getTaskDescription(tool.type, query),
        status: 'pending',
      });
    });
  });

  if (tasks.length === 0) {
    enabledAgents.forEach((agent, index) => {
      if (agent.tools.length > 0) {
        const [tool] = agent.tools;
        tasks.push({
          id: `${agent.id}-${tool.id}-${Date.now() + index}`,
          agentId: agent.id,
          agentName: agent.name,
          agentColor: agent.color,
          task: getTaskDescription(tool.type, query),
          status: 'pending',
        });
      }
    });
  }

  return tasks.slice(0, 6); 
};

const getTaskDescription = (toolType: string, query: string): string => {
  switch (toolType) {
    case 'web':
      return `Searching the web for information about: "${query}"`;
    case 'database':
      return `Querying Neo4j database for relevant data`;
    case 'api':
      return `Making API calls to gather additional context`;
    case 'calculation':
      return `Performing calculations related to the query`;
    case 'file':
      return `Reading and analyzing relevant documents`;
    default:
      return `Processing query with ${toolType} tool`;
  }
};
const generateFinalResponse = (query: string, results: string[]): string => {
  if (results.length === 0) {
    return "I apologize, but I wasn't able to gather any information to answer your question.";
  }

  const summary = results.join(' ');
  
  return `Based on the analysis from multiple agents, here's what I found about "${query}":

${summary}

This response was generated using ${results.length} different tools and agents working together to provide you with comprehensive information.`;
};

export const getDefaultAgents = (): Agent[] => [
  {
    id: 'research_agent',
    name: 'Research Agent',
    description: 'Specializes in web research and information gathering',
    color: '#4CAF50',
    tools: ['web_search'],
    isEnabled: true,
    priority: 1,
  },
  {
    id: 'llm_agent',
    name: 'LLM Agent',
    description: 'AI-powered search, research and analysis using GPT-5',
    color: '#3F51B5',
    tools: ['gpt5_search'],
    isEnabled: true,
    priority: 2,
  },
  {
    id: 'math_agent',
    name: 'Math Agent',
    description: 'Specialized in mathematical operations and calculations',
    color: '#2196F3',
    tools: ['calculate', 'percentage_calculation'],
    isEnabled: true,
    priority: 3,
  },
  {
    id: 'data_agent',
    name: 'Data Agent',
    description: 'Specialized in data visualization and chart creation',
    color: '#FF9800',
    tools: ['create_chart'],
    isEnabled: true,
    priority: 4,
  },
  {
    id: 'code_agent',
    name: 'Code Agent',
    description: 'Specialized in code generation and programming solutions',
    color: '#9C27B0',
    tools: ['code_generation'],
    isEnabled: true,
    priority: 5,
  },
  {
    id: 'neo4j_agent',
    name: 'Neo4j Agent',
    description: 'Specialized in Neo4j GraphRAG knowledge graph queries and analysis',
    color: '#F44336',
    tools: ['graphrag_search'],
    isEnabled: true,
    priority: 6,
  },
];

export const fetchAgentsFromBackend = async (): Promise<Agent[]> => {
  try {
    const response = await fetch(`${BACKEND_URL}/agents`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    
    return data.agents.map((backendAgent: any) => ({
      id: backendAgent.id,
      name: backendAgent.name,
      description: backendAgent.description,
      color: backendAgent.color,
      tools: backendAgent.tools,
      isEnabled: backendAgent.isEnabled,
      priority: backendAgent.priority,
    }));
  } catch (error) {
    return getDefaultAgents();
  }
};

export const testBackendConnection = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BACKEND_URL}/health`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    return response.ok;
  } catch (error) {
    console.error('Backend connection test failed:', error);
    return false;
  }
};

export const getBackendAgents = async (): Promise<Agent[] | null> => {
  try {
    const response = await fetch(`${BACKEND_URL}/agents`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    
    if (response.ok) {
      const data = await response.json();
      return data.agents || null;
    }
    return null;
  } catch (error) {
    console.error('Failed to get backend agents:', error);
    return null;
  }
};

export const cleanupConnections = () => {
  wsManager.disconnectAll();
};
