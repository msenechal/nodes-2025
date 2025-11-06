export interface Agent {
  id: string;
  name: string;
  description: string;
  color: string;
  avatar?: string;
  tools: string[];
  isEnabled: boolean;
  priority: number;
}

export interface Tool {
  id: string;
  name: string;
  description: string;
  type: 'search' | 'database' | 'api' | 'calculation' | 'file' | 'web';
  config?: Record<string, any>;
}

export interface AgentTask {
  id: string;
  agentId: string;
  agentName: string;
  agentColor: string;
  task: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startTime?: number;
  endTime?: number;
  result?: string;
  error?: string;
  progress?: number;
  input?: string;
  graphData?: {
    chunk_nodes?: any[];
    entity_nodes?: any[];
    document_nodes?: any[];
    query?: string;
    answer?: string;
    retrieved_nodes?: any[];
    retrieved_relationships?: any[];
    total_retrieved_nodes?: number;
    total_retrieved_relationships?: number;
    executed_cypher?: string;
  };
}

export interface MultiAgentResponse {
  response: string;
  src: string[];
  agentTasks: AgentTask[];
  totalTime: number;
  sessionTitle?: string;
}
