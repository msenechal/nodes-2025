import { useEffect, useState } from 'react';
import { Typography, Widget, LoadingSpinner, AiPresence, IconButton } from '@neo4j-ndl/react';
import { CheckIconOutline, XMarkIconOutline, ChevronDownIconOutline, ChevronUpIconOutline } from '@neo4j-ndl/react/icons';
import { AgentTask } from '../types/Agent';

interface AgentTaskDisplayProps {
  tasks: AgentTask[];
  isVisible: boolean;
}

export default function AgentTaskDisplay({ tasks, isVisible }: AgentTaskDisplayProps) {
  const [animationTasks, setAnimationTasks] = useState<AgentTask[]>([]);
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [isCollapsed, setIsCollapsed] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const validNewTasks = tasks.filter(task => task && task.id && task.agentColor && task.agentName);
    
    setAnimationTasks(prev => {
      const taskMap = new Map();
      
      prev.forEach(task => {
        if (task && task.id) {
          taskMap.set(task.id, task);
        }
      });
      
      validNewTasks.forEach(task => {
        const existingTask = taskMap.get(task.id);
        
        if (existingTask && 
            existingTask.status === 'running' && 
            task.status === 'completed' && 
            !task.endTime) {
          task = { ...task, endTime: Date.now() };
        }
        
        taskMap.set(task.id, task);
      });
      
      const mergedTasks = Array.from(taskMap.values());
      return mergedTasks;
    });
  }, [tasks]);

  if (!isVisible || tasks.length === 0) {
    return null;
  }

  const getStatusIcon = (status: AgentTask['status']) => {
    switch (status) {
      case 'pending':
        return <div className="w-4 h-4 rounded-full border-2 border-gray-400 opacity-50" />;
      case 'running':
        return <LoadingSpinner size="small" />;
      case 'completed':
        return <CheckIconOutline className="w-4 h-4 text-green-600" />;
      case 'failed':
        return <XMarkIconOutline className="w-4 h-4 text-red-600" />;
      default:
        return null;
    }
  };

  const getStatusText = (status: AgentTask['status']) => {
    switch (status) {
      case 'pending':
        return 'Waiting...';
      case 'running':
        return 'Working...';
      case 'completed':
        return 'Done';
      case 'failed':
        return 'Failed';
      default:
        return status;
    }
  };

  const getElapsedTime = (task: AgentTask) => {
    if (!task.startTime) {
      return '';
    }
    
    let endTime: number;
    if (task.status === 'completed') {
      endTime = task.endTime || (task.startTime + 5000);
    } else if (task.status === 'running') {
      endTime = currentTime;
    } else {
      return '';
    }
    
    const elapsed = Math.round((endTime - task.startTime) / 1000);
    return `${elapsed}s`;
  };

  return (
    <Widget 
      header="" 
      isElevated 
      className="p-4 self-start w-full n-bg-palette-neutral-bg-weak mb-4"
    >
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className='flex items-center'>
            <AiPresence className='w-4 h-4' isThinking /> 
            <Typography variant="body-medium" className="font-semibold ml-2">
              Multi-Agent Processing
            </Typography>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsCollapsed(!isCollapsed)}
              className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors"
              aria-label={isCollapsed ? "Expand agent tasks" : "Collapse agent tasks"}
            >
              {isCollapsed ? (
                <ChevronDownIconOutline className="w-4 h-4 n-text-palette-neutral-text-weak" />
              ) : (
                <ChevronUpIconOutline className="w-4 h-4 n-text-palette-neutral-text-weak" />
              )}
            </button>
          </div>
        </div>
        
        {!isCollapsed && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
              {animationTasks.filter(task => task && task.id && task.agentColor && task.agentName).map((task, index) => (
            <div 
              key={task.id || `task-${index}`}
              className={`relative p-3 rounded-lg border transition-all duration-300 ${
                index < animationTasks.length ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
              }`}
              style={{ 
                borderColor: `${task.agentColor || '#6B7280'}40`,
                backgroundColor: `${task.agentColor || '#6B7280'}05`
              }}
            >
              <div className="flex items-center gap-2 mb-2">
                <div
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ backgroundColor: task.agentColor || '#6B7280' }}
                />
                <Typography 
                  variant="body-small" 
                  className="font-medium truncate flex-1"
                  style={{ color: task.agentColor || '#6B7280' }}
                >
                  {task.agentName || 'Unknown Agent'}
                </Typography>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {getStatusIcon(task.status)}
                  {task.startTime && (
                    <Typography variant="body-small" className="n-text-palette-neutral-text-weak text-xs">
                      {getElapsedTime(task)}
                    </Typography>
                  )}
                </div>
              </div>

              <div className="mb-2">
                <Typography variant="body-small" className="n-text-palette-neutral-text-weak text-xs leading-tight" style={{ 
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden'
                }}>
                  {task.task || 'Processing...'}
                </Typography>
              </div>

              {task.status === 'running' && task.progress !== undefined && (
                <div className="mb-2">
                  <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="h-full transition-all duration-300 ease-out rounded-full"
                      style={{ 
                        width: `${task.progress}%`,
                        backgroundColor: task.agentColor || '#6B7280' 
                      }}
                    />
                  </div>
                </div>
              )}

              <div className="text-center">
                <Typography variant="body-small" className="n-text-palette-neutral-text-weak text-xs">
                  {getStatusText(task.status)}
                </Typography>
              </div>

              {task.status === 'completed' && task.result && (
                <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-600">
                  <Typography variant="body-small" className="n-text-palette-neutral-text text-xs" style={{ 
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden'
                  }}>
                    ✓ {task.result}
                  </Typography>
                </div>
              )}

              {task.status === 'failed' && task.error && (
                <div className="mt-2 pt-2 border-t border-red-200 dark:border-red-600">
                  <Typography variant="body-small" className="text-red-600 text-xs" style={{ 
                    display: '-webkit-box',
                    WebkitLineClamp: 1,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden'
                  }}>
                    ✗ {task.error}
                  </Typography>
                </div>
              )}
            </div>
          ))}
        </div>
        

          </>
        )}
        
        <div className="pt-3 border-t n-border-palette-neutral-border-weak">
          <div className="flex items-center justify-between mb-3">
            <Typography variant="body-small" className="font-medium n-text-palette-neutral-text">
              Overall Progress
            </Typography>
            <div className="flex items-center gap-2">
              <Typography variant="body-small" className="n-text-palette-neutral-text">
                {tasks.filter(t => t.status === 'completed').length}/{tasks.length} agents
              </Typography>
              {tasks.some(t => t.status === 'running') && (
                <div className="flex items-center gap-1">
                  <LoadingSpinner size="small" />
                  <Typography variant="body-small" className="n-text-palette-neutral-text-weak">
                    Processing
                  </Typography>
                </div>
              )}
            </div>
          </div>
          
          <div className="space-y-2">
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3 overflow-hidden">
              <div 
                className="bg-gradient-to-r from-blue-500 to-green-500 h-full rounded-full transition-all duration-500 relative"
                style={{ 
                  width: `${tasks.length > 0 ? (tasks.filter(t => t.status === 'completed').length / tasks.length) * 100 : 0}%` 
                }}
              >
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-pulse" />
              </div>
            </div>
            
            {tasks.length > 0 && (
              <div className="flex justify-between text-xs">
                <div className="flex gap-3">
                  {tasks.filter(t => t.status === 'completed').length > 0 && (
                    <span className="text-green-600 dark:text-green-400">
                      ✓ {tasks.filter(t => t.status === 'completed').length} completed
                    </span>
                  )}
                  {tasks.filter(t => t.status === 'running').length > 0 && (
                    <span className="text-blue-600 dark:text-blue-400">
                      ⟳ {tasks.filter(t => t.status === 'running').length} running
                    </span>
                  )}
                  {tasks.filter(t => t.status === 'pending').length > 0 && (
                    <span className="text-gray-600 dark:text-gray-400">
                      ○ {tasks.filter(t => t.status === 'pending').length} pending
                    </span>
                  )}
                  {tasks.filter(t => t.status === 'failed').length > 0 && (
                    <span className="text-red-600 dark:text-red-400">
                      ✗ {tasks.filter(t => t.status === 'failed').length} failed
                    </span>
                  )}
                </div>
                <span className="text-gray-500 dark:text-gray-400">
                  {Math.round((tasks.filter(t => t.status === 'completed').length / tasks.length) * 100)}% complete
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </Widget>
  );
}
