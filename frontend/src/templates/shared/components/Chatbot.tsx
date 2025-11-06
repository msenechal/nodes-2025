import { useEffect, useRef, useState, useContext } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { Chart as NdlChart } from '@neo4j-ndl/react-charts';
import {
  Button,
  Widget,
  Typography,
  Avatar,
  TextInput,
  IconButton,
  useCopyToClipboard,
  Modal,
  Drawer,
  LoadingSpinner,
  TextLink,
  Menu,
  AiPresence,
  Code,
} from '@neo4j-ndl/react';
import '@neo4j-ndl/base/lib/neo4j-ds-styles.css';
import { Checkbox } from '@neo4j-ndl/react';

import ChatBotAvatar from '../assets/chatbot-ai.png';
import {
  ArrowPathIconOutline,
  ClipboardDocumentIconOutline,
  HandThumbDownIconOutline,
  InformationCircleIconOutline,
  SpeakerWaveIconOutline,
  PencilSquareIconOutline,
  XMarkIconOutline,
  CheckIconOutline,
  TrashIconOutline,
  SidebarLineLeftIcon,
  ArrowRightIconOutline,
  ArrowLeftIconOutline,
  Cog6ToothIconOutline,
  Square2StackIconOutline,
} from '@neo4j-ndl/react/icons';
import RetrievalInformation from './RetrievalInformation';
import AgentTaskDisplay from './AgentTaskDisplay';
import { useChatSession, ChatMessage } from '../../../context/ChatSessionContext';
import { ThemeWrapperContext } from '../../../context/ThemeWrapper';
import { Agent, AgentTask } from '../types/Agent';
import { processMultiAgentQuery, getDefaultAgents, fetchAgentsFromBackend } from '../services/AgentService';

type ChatbotProps = {
  messages?: {
    id: number;
    user: string;
    message: string;
    datetime: string;
    isTyping?: boolean;
    src?: Array<string>;
  }[];
};

type ChatbotResponse = {
  response: string;
  src: string[];
  agentTasks?: AgentTask[];
  userQuery?: string;
};

export default function Chatbot(props: ChatbotProps) {
  const { messages = [] } = props;
  const { colorMode } = useContext(ThemeWrapperContext);
  const {
    currentSession,
    sessions,
    createNewSession,
    switchSession,
    deleteSession,
    addMessageToCurrentSession,
    updateSessionTitle,
  } = useChatSession();

  const hasInitialized = useRef(false);

  useEffect(() => {
    if (sessions.length === 0 && !hasInitialized.current) {
      hasInitialized.current = true;
      if (messages.length > 0) {
        createNewSession('Sample Chat');
        messages.forEach((msg) => {
          addMessageToCurrentSession(msg as ChatMessage);
        });
      } else {
        createNewSession('New Chat');
      }
    }
  }, [sessions.length, messages, createNewSession, addMessageToCurrentSession]);

  const [inputMessage, setInputMessage] = useState('');
  const [, copy] = useCopyToClipboard();
  const [isOpenModal, setIsOpenModal] = useState<boolean>(false);
  const [timeTaken, setTimeTaken] = useState<number>(0);
  const [sourcesModal, setSourcesModal] = useState<string[]>([]);
  const [modelModal, setModelModal] = useState<string>('');
  const [modalAgentTasks, setModalAgentTasks] = useState<AgentTask[]>([]);
  const [modalUserQuery, setModalUserQuery] = useState<string>('');
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(true);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');

  const [typingMessageId, setTypingMessageId] = useState<number | null>(null);
  const [currentTypingText, setCurrentTypingText] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const typingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const typingResponseRef = useRef<ChatbotResponse | null>(null);

  const [agents, setAgents] = useState<Agent[]>(() => {
    const savedAgents = localStorage.getItem('neo4j-chat-agents');
    const defaultAgents = getDefaultAgents();
    
    try {
      if (savedAgents) {
        const parsedAgents = JSON.parse(savedAgents);
        const hasValidTools = parsedAgents.every((agent: Agent) => 
          agent.tools && agent.tools.length > 0
        );
        if (hasValidTools) {
          return parsedAgents;
        }
      }
    } catch (e) {
    }
    
    localStorage.setItem('neo4j-chat-agents', JSON.stringify(defaultAgents));
    return defaultAgents;
  });

  useEffect(() => {
    const loadBackendAgents = async () => {
      try {
        const backendAgents = await fetchAgentsFromBackend();
        setAgents(backendAgents);
        localStorage.setItem('neo4j-chat-agents', JSON.stringify(backendAgents));
      } catch (error) {
        console.error('Failed to load agents from backend:', error);
      }
    };
    
    loadBackendAgents();
  }, []);
  const [currentAgentTasks, setCurrentAgentTasks] = useState<AgentTask[]>([]);
  const [showAgentTasks, setShowAgentTasks] = useState<boolean>(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const settingsAnchorRef = useRef<HTMLButtonElement | null>(null);
  const [isMultiAgentMode, setIsMultiAgentMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('neo4j-chat-multi-agent-mode');
    return saved ? JSON.parse(saved) : true;
  });

  useEffect(() => {
    localStorage.setItem('neo4j-chat-agents', JSON.stringify(agents));
  }, [agents]);

  useEffect(() => {
    localStorage.setItem('neo4j-chat-multi-agent-mode', JSON.stringify(isMultiAgentMode));
  }, [isMultiAgentMode]);

  useEffect(() => {
    if (currentAgentTasks.length > 0) {
      const supervisorStatus = currentAgentTasks.find(task => task.id === 'supervisor_status');
      if (supervisorStatus && 
          (supervisorStatus.status === 'completed' || 
           supervisorStatus.task.includes('Workflow completed successfully'))) {
        if (showAgentTasks) {
          setShowAgentTasks(false);
          setTimeout(() => {
            setCurrentAgentTasks([]);
          }, 3000);
        }
        return;
      }
      
      const hasActiveTasks = currentAgentTasks.some(task => 
        task.status === 'pending' || task.status === 'running'
      );
      
      if (hasActiveTasks && !showAgentTasks) {
        setShowAgentTasks(true);
      }
    } else {
      if (showAgentTasks) {
        setShowAgentTasks(false);
      }
    }
  }, [currentAgentTasks, showAgentTasks]);

  const handleCloseModal = () => setIsOpenModal(false);

  const formattedTextStyle = { color: 'rgb(var(--theme-palette-discovery-bg-strong))' };

  const preprocessMarkdown = (text: string): string => {
    let processed = text;
    processed = processed.replace(/^(\s*)- /gm, '$1- ');
    const lines = processed.split('\n');
    const result: string[] = [];
    let inCodeBlock = false;
    let codeBuffer: string[] = [];
    let currentIndent = '';
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const nextLine = lines[i + 1];
      
      const isCodeLine = line.match(/^    /) || 
                        line.match(/^\s*(import |from |def |function |class |const |let |var |#include|using |package )/);
      
      if (!inCodeBlock && isCodeLine) {
        let codeLineCount = 0;
        for (let j = i; j < Math.min(i + 5, lines.length); j++) {
          const checkLine = lines[j];
          if (checkLine.match(/^    /) || 
              checkLine.match(/^\s*(import |from |def |function |class |const |let |var |#include|using |package |if |for |while |try |catch )/) ||
              checkLine.trim() === '') {
            codeLineCount++;
          } else {
            break;
          }
        }
        
        if (codeLineCount >= 2) {
          inCodeBlock = true;
          currentIndent = line.match(/^(\s*)/)?.[1] || '';
          let language = 'text';
          if (line.includes('import ') || line.includes('from ') || line.includes('def ')) language = 'python';
          else if (line.includes('function ') || line.includes('const ') || line.includes('let ')) language = 'javascript';
          else if (line.includes('#include') || line.includes('int main')) language = 'c';
          else if (line.includes('package ') || line.includes('public class')) language = 'java';
          
          result.push(`\`\`\`${language}`);
          codeBuffer = [];
        }
      }
      
      if (inCodeBlock) {
        const cleanedLine = line.replace(new RegExp(`^${currentIndent}`), '');
        codeBuffer.push(cleanedLine);
        
        if (line.trim() === '' && nextLine && !nextLine.match(/^    /) && nextLine.trim() !== '') {
          result.push(...codeBuffer);
          result.push('```');
          result.push('');
          inCodeBlock = false;
          codeBuffer = [];
        } else if (!nextLine && codeBuffer.length > 0) {
          result.push(...codeBuffer);
          result.push('```');
          inCodeBlock = false;
        }
      } else {
        result.push(line);
      }
    }
    
    if (inCodeBlock && codeBuffer.length > 0) {
      result.push(...codeBuffer);
      result.push('```');
    }
    
    processed = result.join('\n');
    
    processed = processed.replace(/\b([A-Z][A-Z_]*[A-Z])\b(?!`)/g, '`$1`');
    processed = processed.replace(/\b(neo4j\+s:\/\/[^\s]+)/g, '`$1`');
    processed = processed.replace(/\b(pip install [^\n]+)/g, '```bash\n$1\n```');
    
    return processed;
  };

  const renderCode = (props: any) => {
    const { children, className, node, inline } = props;
    const match = /language-(\w+)/.exec(className || '');
    const language = match ? match[1] : 'text';
    const codeString = String(children).replace(/\n$/, '');

    const isInline = inline === true;
    const hasLanguage = !!className && className.startsWith('language-');
    
    const languageMap: { [key: string]: string } = {
      'js': 'javascript',
      'ts': 'typescript',
      'py': 'python',
      'sh': 'bash',
      'yml': 'yaml',
      'txt': 'text'
    };
    
    const mappedLanguage = languageMap[language] || language;
    
    const supportedLanguages = [
      'text', 'asciidoc', 'bash', 'c', 'csharp', 'css', 'css-extras', 'cypher', 'docker', 'json', 
      'go', 'graphql', 'java', 'javadoc', 'javascript', 'jsx', 'kotlin', 'php', 'python', 'rust', 
      'scala', 'sql', 'swift', 'typescript', 'xml', 'yaml'
    ];
    
    const finalLanguage = supportedLanguages.includes(mappedLanguage) ? mappedLanguage : 'text';
    
    if (!isInline && (hasLanguage || codeString.includes('\n'))) {
      return (
        <div style={{ margin: '16px 0' }}>
          <Code
            code={codeString}
            type="block"
            language={finalLanguage as any}
            showLineNumbers={codeString.split('\n').length > 3}
            theme="ndl-code-light"
            actions={[
              {
                ariaLabel: 'copy',
                children: (
                  <Square2StackIconOutline className="n-text-palette-neutral-text-icon" />
                ),
                htmlAttributes: { title: 'Copy code' },
                onClick: () => {
                  navigator.clipboard.writeText(codeString);
                },
              },
            ]}
          />
        </div>
      );
    } else {
      return (
        <span style={formattedTextStyle} className="n-bg-palette-neutral-bg-weak n-border-palette-neutral-border px-1 rounded text-sm font-mono">
          {children}
        </span>
      );
    }
  };

  const renderInput = (props: any) => {
    const { type, checked, disabled } = props;
    if (type === 'checkbox') {
      return (
        <span style={{ display: 'inline-flex', verticalAlign: 'middle' }}>
          <Checkbox
            label={''}
            isChecked={!!checked}
            isDisabled={false}
            onClick={() => console.debug('Checkbox clicked (input renderer)', checked)}
          />
        </span>
      );
    }
    return <input {...props} />;
  };

  const renderListItem = ({ children, checked, ...props }: any) => {
    if (typeof checked === 'boolean') {
      const labelText = Array.isArray(children)
        ? children.map((c: any) => (typeof c === 'string' ? c : (c?.props?.children ?? String(c)))).join('')
        : String(children);
      const label = labelText.replace(/^\s*-?\s*/, '').trim();

      return (
        <li {...props} style={{ listStyle: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Checkbox
              label={label}
              isChecked={checked}
              onClick={() => {
                console.debug('Checkbox clicked:', label, checked);
              }}
            />
          </div>
        </li>
      );
    }

    return <li {...props}>{children}</li>;
  };

  const convertEChartsToDataset = (echartsConfig: any) => {
    const { xAxis, series } = echartsConfig;
    const categories = xAxis.categories || [];
    const headers = [xAxis.title || 'Category'];
    series.forEach((s: any) => headers.push(s.name || 'Series'));
    const source = [headers];
    for (let i = 0; i < categories.length; i++) {
      const row = [categories[i]];
      series.forEach((s: any) => {
        row.push(s.data[i] || 0);
      });
      source.push(row);
    }
  
    return source;
  };

  const parseChartsFromText = (text: string) => {
    const charts = [];
    try {
      const markerPattern = /CHART_JSON_START\s*\n?(.*?)\n?\s*CHART_JSON_END/gs;
      const markerMatches = [...text.matchAll(markerPattern)];
      
      if (markerMatches.length > 0) {
        for (const match of markerMatches) {
          let jsonPart = match[1].trim();
          
          jsonPart = jsonPart
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '')
            .replace(/,\s*}/g, '}')
            .replace(/,\s*]/g, ']');
          
          try {
            const parsedJson = JSON.parse(jsonPart);
            if (parsedJson && parsedJson.title && parsedJson.xAxis && parsedJson.series) {
              
              const convertedChart = {
                type: 'line', 
                title: parsedJson.title,
                data: {
                  dataset: [{
                    source: convertEChartsToDataset(parsedJson)
                  }]
                }
              };
              
              charts.push(convertedChart);
              continue;
            }
            
            if (parsedJson && 
                (parsedJson.type || parsedJson.chart_type) && 
                parsedJson.data &&
                ['bar', 'line', 'pie'].includes(parsedJson.type || parsedJson.chart_type)) {
              if (parsedJson.chart_type && !parsedJson.type) {
                parsedJson.type = parsedJson.chart_type;
              }
              if (parsedJson.data && parsedJson.data.datasets && parsedJson.data.labels) {
                const labels = parsedJson.data.labels;
                const datasets = parsedJson.data.datasets;
                const source = [labels];
                
                for (let i = 0; i < labels.length; i++) {
                  const row = [labels[i]];
                  datasets.forEach((dataset: any) => {
                    row.push(dataset.data[i]);
                  });
                  source.push(row);
                }
                
                parsedJson.data = {
                  dataset: [{
                    source: source
                  }]
                };
              }
              
              charts.push(parsedJson);
            }
          } catch (e) {
            console.error('Error parsing chart JSON from markers:', e, 'JSON:', jsonPart);
            continue;
          }
        }
        
        if (charts.length > 0) {
          return charts;
        }
      }
      const cleanText = text.replace(/^\[|\]$/g, '');
      const arrayJsonPattern = /\[(\{(?:[^{}]|{(?:[^{}]|{[^{}]*})*})*\})\]/g;
      const arrayMatches = [...cleanText.matchAll(arrayJsonPattern)];
      
      if (arrayMatches) {
        for (const match of arrayMatches) {
          let jsonPart = match[1];
          jsonPart = jsonPart
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '')
            .replace(/,\s*}/g, '}')
            .replace(/,\s*]/g, ']');
          
          try {
            const parsedJson = JSON.parse(jsonPart);
            if (parsedJson && 
                (parsedJson.type || parsedJson.chart_type) && 
                parsedJson.data &&
                ['bar', 'line', 'pie'].includes(parsedJson.type || parsedJson.chart_type)) {
              if (parsedJson.chart_type && !parsedJson.type) {
                parsedJson.type = parsedJson.chart_type;
              }
              
              return parsedJson;
            }
          } catch (e) {
            continue;
          }
        }
      }

      const labeledJsonPattern = /(?:(?:Bar Chart|Pie Chart|Line Chart)?\s*JSON Output:|\[Raw JSON from create_chart tool\])\s*(\{(?:[^{}]|{(?:[^{}]|{[^{}]*})*})*\})/gi;
      const labeledMatch = cleanText.match(labeledJsonPattern);
      
      if (labeledMatch) {
        for (const match of labeledMatch) {
          const jsonPart = match.replace(/^.*(?:JSON Output:|\[Raw JSON from create_chart tool\])\s*/i, '');
          try {
            const parsedJson = JSON.parse(jsonPart);
            if (parsedJson && 
                (parsedJson.type || parsedJson.chart_type) && 
                parsedJson.data &&
                ['bar', 'line', 'pie'].includes(parsedJson.type || parsedJson.chart_type)) {
              if (parsedJson.chart_type && !parsedJson.type) {
                parsedJson.type = parsedJson.chart_type;
              }
              
              return parsedJson;
            }
          } catch (e) {
            continue;
          }
        }
      }
      const jsonPattern = /\{(?:[^{}]|{(?:[^{}]|{[^{}]*})*})*\}/g;
      const matches = cleanText.match(jsonPattern);
      
      if (matches) {
        for (const match of matches) {
          let cleanMatch = match
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '')
            .replace(/,\s*}/g, '}')
            .replace(/,\s*]/g, ']');
          
          try {
            const parsedJson = JSON.parse(cleanMatch);
            if (parsedJson && 
                (parsedJson.type || parsedJson.chart_type) && 
                parsedJson.data &&
                ['bar', 'line', 'pie'].includes(parsedJson.type || parsedJson.chart_type)) {
              if (parsedJson.chart_type && !parsedJson.type) {
                parsedJson.type = parsedJson.chart_type;
              }
              if (parsedJson.data && parsedJson.data.dataset && parsedJson.data.dataset[0] && parsedJson.data.dataset[0].source) {
                return parsedJson;
              }
              if (parsedJson.data && parsedJson.data.datasets && parsedJson.data.labels) {
                const labels = parsedJson.data.labels;
                const datasets = parsedJson.data.datasets;
                const source = [labels];
                for (let i = 0; i < labels.length; i++) {
                  const row = [labels[i]];
                  datasets.forEach((dataset: any) => {
                    row.push(dataset.data[i]);
                  });
                  source.push(row);
                }
                
                parsedJson.data = {
                  dataset: [{
                    source: source
                  }]
                };
              }
              
              return parsedJson;
            }
          } catch (e) {
            continue;
          }
        }
      }
      
    } catch (e) {
      console.log('Failed to parse chart config:', e);
    }
    return null;
  };

  const renderChart = (chartConfig: any) => {
    const { type, data, title } = chartConfig;
    const isDarkMode = colorMode === 'dark';
    
    if (!data?.dataset?.[0]?.source) {
      return (
        <div style={{
          border: `1px solid ${isDarkMode ? '#374151' : '#ddd'}`,
          borderRadius: '10px',
          padding: '20px',
          margin: '10px 0',
          backgroundColor: isDarkMode ? '#1f2937' : '#f0f8ff',
          color: isDarkMode ? '#e5e7eb' : '#1f2937'
        }}>
          <Typography variant="body-medium">
            Chart data not available
          </Typography>
        </div>
      );
    }

    const source = data.dataset[0].source;
    const dimensions = source[0];
    const chartData = source;

    const chartTitle = title || `${type.charAt(0).toUpperCase() + type.slice(1)} Chart`;

    const chartColors = isDarkMode 
      ? ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#84cc16', '#f97316']
      : ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#0284c7', '#65a30d', '#ea580c'];

    let series: any[] = [];
    let xAxis: any = {};
    let yAxis: any = {};

    if (type === 'bar') {
      const numericColumns = dimensions.slice(1);
      series = numericColumns.map((column: string, index: number) => ({
        type: 'bar',
        name: column,
        encode: {
          x: dimensions[0],
          y: column,
        },
        itemStyle: {
          color: chartColors[index % chartColors.length]
        }
      }));

      xAxis = {
        type: 'category',
        name: dimensions[0],
        axisLabel: {
          color: isDarkMode ? '#d1d5db' : '#374151'
        },
        axisLine: {
          lineStyle: {
            color: isDarkMode ? '#4b5563' : '#d1d5db'
          }
        }
      };
      
      yAxis = {
        type: 'value',
        name: numericColumns.join(', '),
        axisLabel: {
          color: isDarkMode ? '#d1d5db' : '#374151'
        },
        axisLine: {
          lineStyle: {
            color: isDarkMode ? '#4b5563' : '#d1d5db'
          }
        },
        splitLine: {
          lineStyle: {
            color: isDarkMode ? '#374151' : '#e5e7eb'
          }
        }
      };
    } else if (type === 'line') {
      const numericColumns = dimensions.slice(1);
      series = numericColumns.map((column: string, index: number) => ({
        type: 'line',
        name: column,
        encode: {
          x: dimensions[0],
          y: column,
        },
        itemStyle: {
          color: chartColors[index % chartColors.length]
        },
        lineStyle: {
          color: chartColors[index % chartColors.length]
        }
      }));

      xAxis = {
        type: 'category',
        name: dimensions[0],
        axisLabel: {
          color: isDarkMode ? '#d1d5db' : '#374151'
        },
        axisLine: {
          lineStyle: {
            color: isDarkMode ? '#4b5563' : '#d1d5db'
          }
        }
      };
      
      yAxis = {
        type: 'value',
        name: numericColumns.join(', '),
        axisLabel: {
          color: isDarkMode ? '#d1d5db' : '#374151'
        },
        axisLine: {
          lineStyle: {
            color: isDarkMode ? '#4b5563' : '#d1d5db'
          }
        },
        splitLine: {
          lineStyle: {
            color: isDarkMode ? '#374151' : '#e5e7eb'
          }
        }
      };
    } else if (type === 'pie') {
      series = [{
        type: 'pie',
        radius: '50%',
        encode: {
          itemName: dimensions[0],
          value: dimensions[1],
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 10,
            shadowOffsetX: 0,
            shadowColor: 'rgba(0, 0, 0, 0.5)'
          }
        },
        itemStyle: {
          color: (params: any) => chartColors[params.dataIndex % chartColors.length]
        }
      }];
    }

    const chartProps = {
      dataset: {
        dimensions: dimensions,
        source: chartData,
      },
      series: series,
      xAxis: type !== 'pie' ? xAxis : undefined,
      yAxis: type !== 'pie' ? yAxis : undefined,
      legend: {
        show: true,
        type: 'scroll',
        textStyle: {
          color: isDarkMode ? '#d1d5db' : '#374151'
        }
      },
      tooltip: {
        trigger: type === 'pie' ? 'item' : 'axis',
        formatter: type === 'pie' 
          ? '{a} <br/>{b}: {c} ({d}%)'
          : undefined,
        backgroundColor: isDarkMode ? '#374151' : '#ffffff',
        textStyle: {
          color: isDarkMode ? '#e5e7eb' : '#1f2937'
        },
        borderColor: isDarkMode ? '#4b5563' : '#d1d5db'
      },
      grid: type !== 'pie' ? {
        left: '10%',
        right: '10%',
        bottom: '15%',
        containLabel: true
      } : undefined,
      backgroundColor: 'transparent'
    };

    return (
      <div style={{
        border: `1px solid ${isDarkMode ? '#374151' : '#e1e5e9'}`,
        borderRadius: '8px',
        padding: '16px',
        margin: '10px 0',
        backgroundColor: isDarkMode ? '#1f2937' : '#ffffff',
        minHeight: '400px'
      }}>
        <Typography variant="h6" style={{ 
          marginBottom: '16px', 
          color: isDarkMode ? '#e5e7eb' : '#1f2937' 
        }}>
          📊 {chartTitle}
        </Typography>
        <div style={{ height: '350px', width: '100%' }}>
          <NdlChart {...chartProps} />
        </div>
      </div>
    );
  };

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputMessage(e.target.value);
  };

  const stopTypingSimulation = () => {
    if (typingIntervalRef.current) {
      clearInterval(typingIntervalRef.current);
      typingIntervalRef.current = null;
    }
    if (typingMessageId && currentTypingText.trim()) {
      const date = new Date();
      const datetime = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
      
      const partialMessage: ChatMessage = {
        id: typingMessageId,
        user: 'chatbot',
        message: currentTypingText,
        datetime: datetime,
        isTyping: false,
        src: [],
      };
      addMessageToCurrentSession(partialMessage);
    }
    setTypingMessageId(null);
    setCurrentTypingText('');
  };

  const skipTyping = () => {
    if (typingIntervalRef.current) {
      clearInterval(typingIntervalRef.current);
      typingIntervalRef.current = null;
    }

    const currentTypingData = typingResponseRef.current;
    if (typingMessageId && currentTypingData) {
      const date = new Date();
      const datetime = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
      
      const finalMessage: ChatMessage = {
        id: typingMessageId,
        user: 'chatbot',
        message: currentTypingData.response,
        datetime: datetime,
        isTyping: false,
        src: currentTypingData.src,
        agentTasks: currentTypingData.agentTasks,
        userQuery: currentTypingData.userQuery,
      };
      addMessageToCurrentSession(finalMessage);
    }

    setTypingMessageId(null);
    setCurrentTypingText('');
    typingResponseRef.current = null;
  };

  const simulateTypingEffect = (responseText: ChatbotResponse, userQuery?: string) => {
    if (typingIntervalRef.current) {
      clearInterval(typingIntervalRef.current);
      typingIntervalRef.current = null;
    }

    if (showAgentTasks) {
      setShowAgentTasks(false);
      setTimeout(() => {
        setCurrentAgentTasks([]);
      }, 300);
    }

    typingResponseRef.current = { ...responseText, userQuery };

    const date = new Date();
    const datetime = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
    const messageId = Date.now();

    setTypingMessageId(messageId);
    setCurrentTypingText('');

    let currentIndex = 0;
    typingIntervalRef.current = setInterval(() => {
      if (currentIndex < responseText.response.length) {
        const currentText = responseText.response.substring(0, currentIndex + 1);
        setCurrentTypingText(currentText);
        currentIndex += 1;
      } else {
        setCurrentTypingText('');
        setTypingMessageId(null);
        if (typingIntervalRef.current) {
          clearInterval(typingIntervalRef.current);
          typingIntervalRef.current = null;
        }

        const existingMessage = currentSession?.messages.find(msg => msg.id === messageId);
        if (!existingMessage) {
          const finalMessage: ChatMessage = {
            id: messageId,
            user: 'chatbot',
            message: responseText.response,
            datetime: datetime,
            isTyping: false,
            src: responseText.src,
            agentTasks: responseText.agentTasks,
            userQuery: userQuery,
          };
          addMessageToCurrentSession(finalMessage);
        }
      }
    }, 20);
  };

  const handleSubmit = async (e: { preventDefault: () => void }) => {
    e.preventDefault();
    if (!inputMessage.trim() || !currentSession) {
      return;
    }
    
    stopTypingSimulation();
    
    const date = new Date();
    const datetime = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
    const userMessage: ChatMessage = { 
      id: Date.now(), 
      user: 'user', 
      message: inputMessage, 
      datetime: datetime 
    };
    
    addMessageToCurrentSession(userMessage);
    const currentQuery = inputMessage;
    setInputMessage('');

    setIsLoading(true);
    setCurrentAgentTasks([]);

    if (isMultiAgentMode) {
      try {
        const enabledAgents = agents.filter(a => a.isEnabled);
        if (enabledAgents.length === 0) {
          const errorReply: ChatbotResponse = {
            response: `Debug: No enabled agents found. Total agents: ${agents.length}. Please check agent configuration.`,
            src: [],
          };
          setIsLoading(false);
          setCurrentAgentTasks([]);
          simulateTypingEffect(errorReply, currentQuery);
          return;
        }

        const conversationHistory = currentSession?.messages
          .filter(msg => msg.id !== userMessage.id)
          .map(msg => ({
            role: msg.user === 'user' ? 'user' : 'assistant',
            content: msg.message,
            timestamp: msg.datetime
          })) || [];

        const result = await processMultiAgentQuery(
          currentQuery,
          agents,
          (newTasks) => {
            const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + String(new Date().getMilliseconds()).padStart(3, '0');
            setCurrentAgentTasks(newTasks);
          },
          (sessionId: string, title: string) => {
            if (currentSession) {
              updateSessionTitle(currentSession.id, title);
            }
          },
          currentSession?.id,
          conversationHistory
        );

        const chatbotReply: ChatbotResponse = {
          response: result.response,
          src: result.src,
          agentTasks: result.agentTasks,
        };

        if (result.sessionTitle && currentSession) {
          const userMessages = currentSession.messages.filter(msg => msg.user === 'user');
          
          if (userMessages.length <= 1 && (
            currentSession.title === 'New Chat' || 
            currentSession.title.startsWith('New Chat') ||
            currentSession.title.startsWith('Chat ')
          )) {
            updateSessionTitle(currentSession.id, result.sessionTitle);
          } else {
            console.log('Skipping title update');
          }
        }

        setIsLoading(false);
        simulateTypingEffect(chatbotReply, currentQuery);
      } catch (error) {
        const errorReply: ChatbotResponse = {
          response: 'Sorry, I encountered an error while processing your request with the agent system. Please try again.',
          src: [],
        };
        
        setIsLoading(false);
        simulateTypingEffect(errorReply, currentQuery);
      }
    } else {
      await new Promise(resolve => setTimeout(resolve, 1000));

      const chatbotReply: ChatbotResponse = {
        response: 'Hello, here is an example response with sources. To use the chatbot, plug this to your backend with a fetch containing an object response of type: {response: string, src: Array<string>}',
        src: ['1:1234-abcd-efgh-ijkl-5678:2', '3:8765-zyxw-vuts-rqpo-4321:4'],
      };

      setIsLoading(false);
      simulateTypingEffect(chatbotReply, currentQuery);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
  }, [currentSession?.messages, typingMessageId, currentTypingText, isLoading, currentAgentTasks]);

  useEffect(() => {
    return () => {
      if (typingIntervalRef.current) {
        clearInterval(typingIntervalRef.current);
      }
    };
  }, []);

  const handleNewSession = () => {
    stopTypingSimulation();
    createNewSession();
  };

  const handleSwitchSession = (sessionId: string) => {
    stopTypingSimulation();
    switchSession(sessionId);
  };

  const handleDeleteSession = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    stopTypingSimulation();
    deleteSession(sessionId);
  };

  const handleEditSession = (sessionId: string, currentTitle: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSessionId(sessionId);
    setEditTitle(currentTitle);
  };

  const handleSaveEdit = (sessionId: string) => {
    if (editTitle.trim()) {
      updateSessionTitle(sessionId, editTitle.trim());
    }
    setEditingSessionId(null);
    setEditTitle('');
  };

  const handleCancelEdit = () => {
    setEditingSessionId(null);
    setEditTitle('');
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffTime = Math.abs(now.getTime() - date.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 1) {
      return 'Today';
    }
    if (diffDays === 2) {
      return 'Yesterday';
    }
    if (diffDays < 7) {
      return `${diffDays - 1} days ago`;
    }
    return date.toLocaleDateString();
  };

  const currentMessages = currentSession?.messages || [];

  return (
    <div className='h-screen flex relative overflow-hidden n-bg-palette-neutral-bg-default'>
      <Drawer className='max-w-80' isExpanded={isDrawerOpen} onExpandedChange={setIsDrawerOpen} type='push' isCloseable={false}>
        <Drawer.Header>
          <div className='flex items-center w-full'>
            <Button color='neutral' onClick={handleNewSession} fill='outlined'>
              <PencilSquareIconOutline className='w-4 h-4 mr-4' /> New chat
            </Button>
          </div>
        </Drawer.Header>
        <Drawer.Body className="flex flex-col h-full">
          {sessions.length === 0 ? (
            <div className='flex flex-col p-4 text-center flex-1'>
              <Typography variant='body-medium' className='n-text-palette-neutral-text-weak'>
                No chat sessions yet.
              </Typography>
              <Button onClick={handleNewSession} className='mt-3' size='small'>
                Start New Chat
              </Button>
            </div>
          ) : (
            <div 
              className='flex-1 overflow-y-auto chat-sessions-scroll'
              style={{
                scrollbarWidth: 'thin',
              }}
            >
              <div className='space-y-1 p-3'>
                <div className='text-left'>
                  <Typography variant='body-medium' className='n-text-palette-neutral-text-weak'>
                    Chats
                  </Typography>
                </div>
                {sessions.map((session) => (
                  <div
                    key={session.id}
                    className={`group relative p-3 rounded-xl cursor-pointer transition-all duration-200 ${
                      session.id === currentSession?.id
                        ? 'n-bg-palette-primary-bg-selected'
                        : 'hover:n-bg-palette-primary-hover-weak'
                    }`}
                    onClick={() => handleSwitchSession(session.id)}
                  >
                    {editingSessionId === session.id ? (
                      <div className='flex items-center gap-2' onClick={(e) => e.stopPropagation()}>
                        <TextInput
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          htmlAttributes={{
                            onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
                              if (e.key === 'Enter') {
                                handleSaveEdit(session.id);
                              } else if (e.key === 'Escape') {
                                handleCancelEdit();
                              }
                            },
                            autoFocus: true,
                          }}
                          className='flex-1'
                          size='small'
                        />
                        <IconButton isClean ariaLabel='Save' onClick={() => handleSaveEdit(session.id)} size='small'>
                          <CheckIconOutline className='w-3 h-3' />
                        </IconButton>
                        <IconButton isClean ariaLabel='Cancel' onClick={handleCancelEdit} size='small'>
                          <XMarkIconOutline className='w-3 h-3' />
                        </IconButton>
                      </div>
                    ) : (
                      <>
                        <div className='flex items-start justify-between'>
                          <div className='flex flex-col min-w-0'>
                            <Typography
                              variant='body-medium'
                              className={`truncate ${
                                session.id === currentSession?.id
                                  ? 'n-text-palette-primary-text'
                                  : 'n-text-palette-neutral-text'
                              }`}
                            >
                              {session.title}
                            </Typography>
                            <Typography variant='body-small' className='n-text-palette-neutral-text-weak mt-1'>
                              {formatDate(session.updatedAt)} • {session.messages.length} messages
                            </Typography>
                          </div>

                          <div className='flex ml-4 items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity'>
                            <IconButton
                              isClean
                              ariaLabel='Edit'
                              onClick={(e) => handleEditSession(session.id, session.title, e)}
                              size='small'
                            >
                              <PencilSquareIconOutline className='w-3 h-3' />
                            </IconButton>
                            <IconButton
                              isClean
                              ariaLabel='Delete'
                              onClick={(e) => handleDeleteSession(session.id, e)}
                              size='small'
                              className='n-text-palette-danger-text hover:n-bg-palette-danger-bg-weak'
                            >
                              <TrashIconOutline className='w-3 h-3' />
                            </IconButton>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          
        </Drawer.Body>
      </Drawer>

      <div className='flex-1 flex flex-col h-screen'>
        <div className='n-bg-palette-neutral-bg-weak p-4 flex items-center gap-4'>
          <IconButton
            isClean
            ariaLabel='Open Chat History'
            onClick={() => setIsDrawerOpen(!isDrawerOpen)}
            className='group relative hover:n-bg-palette-neutral-bg transition-all duration-200'
          >
            <SidebarLineLeftIcon className='w-6 h-6 opacity-100 group-hover:opacity-0 transition-opacity duration-200' />
            <ArrowRightIconOutline
              className={`absolute inset-0 w-6 h-6 m-auto opacity-0 group-hover:opacity-100 transition-opacity duration-200 ${
                isDrawerOpen ? 'hidden' : 'block'
              }`}
            />
            <ArrowLeftIconOutline
              className={`absolute inset-0 w-6 h-6 m-auto opacity-0 group-hover:opacity-100 transition-opacity duration-200 ${
                isDrawerOpen ? 'block' : 'hidden'
              }`}
            />
          </IconButton>
          <div className="flex-1">
            <Typography variant='h6' className='n-text-palette-neutral-text'>
              {currentSession?.title || 'New Chat'}
            </Typography>
            <Typography variant='body-small' className='n-text-palette-neutral-text-weak'>
              {currentMessages.length} messages
            </Typography>
          </div>
        </div>
        {showAgentTasks && currentAgentTasks.length > 0 && (
          <div className="p-3">
            <AgentTaskDisplay tasks={currentAgentTasks} isVisible={showAgentTasks} />
          </div>
        )}
        <div className='flex-1 overflow-y-auto pb-6 n-bg-palette-neutral-bg-default'>
          <div className='flex flex-col gap-3 p-3 min-h-full'>
            {currentMessages.map((chat) => (
              <div
                ref={messagesEndRef}
                key={chat.id}
                className={`flex gap-2.5 items-end ${chat.user === 'chatbot' ? 'flex-row' : 'flex-row-reverse'} `}
              >
                <div className='w-8 h-8 mr-4 ml-4'>
                  {chat.user === 'chatbot' ? (
                    <Avatar
                      className='-ml-4'
                      hasStatus
                      name='KM'
                      size='x-large'
                      source={ChatBotAvatar}
                      status='online'
                      type='image'
                      shape='square'
                    />
                  ) : (
                    <Avatar
                      className=''
                      hasStatus
                      name='KM'
                      size='x-large'
                      status='online'
                      type='image'
                      shape='square'
                    />
                  )}
                </div>
                <Widget
                  header=''
                  isElevated={true}
                  className={`p-4 self-start max-w-[55%] ${
                    chat.user === 'chatbot' ? 'n-bg-palette-neutral-bg-weak' : 'n-bg-palette-primary-bg-weak'
                  }`}
                >
                  <div>
                    {(() => {
                      const chartConfigs = parseChartsFromText(chat.message);
                      const chartConfig = chartConfigs && chartConfigs.length > 0 ? chartConfigs[0] : null;
                      if (chartConfig) {
                        const textWithoutChart = chat.message
                          .replace(/\[(\{(?:[^{}]|{(?:[^{}]|{[^{}]*})*})*\})\]/g, (match) => {
                            try {
                              let jsonPart = match.replace(/^\[|\]$/g, '');
                              jsonPart = jsonPart
                                .replace(/\/\*[\s\S]*?\*\//g, '')
                                .replace(/\/\/.*$/gm, '')
                                .replace(/,\s*}/g, '}')
                                .replace(/,\s*]/g, ']');
                              const parsed = JSON.parse(jsonPart);
                              if (parsed && (parsed.type || parsed.chart_type) && parsed.data && 
                                  ['bar', 'line', 'pie'].includes(parsed.type || parsed.chart_type)) {
                                return '';
                              }
                            } catch (e) {
                            }
                            return match;
                          })
                          .replace(/CHART_JSON_START\s*\n?(.*?)\n?\s*CHART_JSON_END/gs, '')
                          .replace(/(?:(?:Bar Chart|Pie Chart|Line Chart)?\s*JSON Output:|\[Raw JSON from create_chart tool\])\s*\{(?:[^{}]|{(?:[^{}]|{[^{}]*})*})*\}/gi, '')
                          .replace(/\{(?:[^{}]|{(?:[^{}]|{[^{}]*})*})*\}/g, (match) => {
                            try {
                              let cleanMatch = match
                                .replace(/\/\*[\s\S]*?\*\//g, '')
                                .replace(/\/\/.*$/gm, '')
                                .replace(/,\s*}/g, '}')
                                .replace(/,\s*]/g, ']'); 
                              const parsed = JSON.parse(cleanMatch);
                              if (parsed && (parsed.type || parsed.chart_type) && parsed.data && 
                                  ['bar', 'line', 'pie'].includes(parsed.type || parsed.chart_type)) {
                                return '';
                              }
                            } catch (e) {
                            }
                            return match;
                          })
                          .replace(/^\[|\]$/g, '')
                          .trim();
                        return (
                          <div className='flex flex-col gap-4'>
                            {textWithoutChart && (
                              <ReactMarkdown
                                  components={{
                                    code: renderCode,
                                    ...( { li: renderListItem } as any),
                                    input: renderInput,
                                    a: ({ ...props }) => (
                                      <TextLink type="external" href={props.href} target="_blank" >{props.children}</TextLink>
                                    )
                                  } as any}
                                  remarkPlugins={[remarkGfm]} 
                                  rehypePlugins={[rehypeRaw]}
                                >
                                {preprocessMarkdown(textWithoutChart)}
                              </ReactMarkdown>
                            )}
                            {chartConfigs.map((chartConfig: any, index: number) => (
                              <div key={index}>
                                {renderChart(chartConfig)}
                              </div>
                            ))}
                          </div>
                        );
                      } else {
                        return (
                          <div className='flex flex-col gap-4'>
                            <ReactMarkdown
                              components={{
                                code: renderCode,
                                a: ({ ...props }) => (
                                  <TextLink type="external" href={props.href} target="_blank" >{props.children}</TextLink>
                                )
                              }}
                              remarkPlugins={[remarkGfm]} 
                              rehypePlugins={[rehypeRaw]}
                            >
                              {chat.message}
                            </ReactMarkdown>
                          </div>
                        );
                      }
                    })()}
                  </div>
                  <div className='text-right align-bottom pt-3'>
                    <Typography variant='body-small'>{chat.datetime}</Typography>
                  </div>
                  <Typography variant='body-small' className='text-right'>
                    {chat.user === 'chatbot' ? (
                      <div className='flex gap-1'>
                        <>
                          <IconButton isClean ariaLabel='Search Icon'>
                            <SpeakerWaveIconOutline className='w-4 h-4 inline-block' />
                          </IconButton>
                          {chat.src && chat.src.length > 0 ? (
                            <IconButton
                              isClean
                              ariaLabel='Search Icon'
                              onClick={() => {
                                setModelModal('OpenAI GPT 5');
                                setSourcesModal(chat.src ?? []);
                                setModalAgentTasks(chat.agentTasks ?? []);
                                setModalUserQuery(chat.userQuery ?? '');
                                setTimeTaken(50);
                                setIsOpenModal(true);
                              }}
                            >
                              <InformationCircleIconOutline className='w-4 h-4 inline-block' />
                            </IconButton>
                          ) : null}
                          <IconButton isClean ariaLabel='Search Icon' onClick={() => copy(chat.message)}>
                            <ClipboardDocumentIconOutline className='w-4 h-4 inline-block' />
                          </IconButton>
                          <IconButton isClean ariaLabel='Search Icon'>
                            <ArrowPathIconOutline className='w-4 h-4 inline-block' />
                          </IconButton>
                          <IconButton isClean ariaLabel='Search Icon'>
                            <HandThumbDownIconOutline className='w-4 h-4 inline-block n-text-palette-danger-text' />
                          </IconButton>
                        </>
                      </div>
                    ) : (
                      <></>
                    )}
                  </Typography>
                </Widget>
              </div>
            ))}

            {isLoading && (
              <div ref={messagesEndRef} className='flex gap-2.5 items-end flex-row'>
                <div className='w-8 h-8 mr-4 ml-4'>
                  <Avatar
                    className='-ml-4'
                    hasStatus
                    name='KM'
                    size='x-large'
                    source={ChatBotAvatar}
                    status='online'
                    type='image'
                    shape='square'
                  />
                </div>
                <Widget header='' isElevated={true} className='p-4 self-start max-w-[55%] n-bg-palette-neutral-bg-weak'>
                  <div className='flex items-center gap-2'>
                    <AiPresence className="n-size-token-8" isThinking={true} />
                    <Typography variant='body-medium'>Thinking...</Typography>
                  </div>
                </Widget>
              </div>
            )}

            {typingMessageId && currentTypingText && (
              <div ref={messagesEndRef} className='flex gap-2.5 items-end flex-row'>
                <div className='w-8 h-8 mr-4 ml-4'>
                  <Avatar
                    className='-ml-4'
                    hasStatus
                    name='KM'
                    size='x-large'
                    source={ChatBotAvatar}
                    status='online'
                    type='image'
                    shape='square'
                  />
                </div>
                <Widget header='' isElevated={true} className='p-4 self-start max-w-[55%] n-bg-palette-neutral-bg-weak'>
                  <div>
                    {(() => {
                      const chartConfigs = parseChartsFromText(currentTypingText);
                      if (chartConfigs && chartConfigs.length > 0) {
                        const textWithoutChart = currentTypingText
                          .replace(/\[(\{(?:[^{}]|{(?:[^{}]|{[^{}]*})*})*\})\]/g, (match) => {
                            try {
                              let jsonPart = match.replace(/^\[|\]$/g, '');
                              jsonPart = jsonPart
                                .replace(/\/\*[\s\S]*?\*\//g, '')
                                .replace(/\/\/.*$/gm, '')
                                .replace(/,\s*}/g, '}')
                                .replace(/,\s*]/g, ']');
                              const parsed = JSON.parse(jsonPart);
                              if (parsed && (parsed.type || parsed.chart_type) && parsed.data && 
                                  ['bar', 'line', 'pie'].includes(parsed.type || parsed.chart_type)) {
                                return '';
                              }
                            } catch (e) {
                            }
                            return match;
                          })
                          .replace(/CHART_JSON_START\s*\n?(.*?)\n?\s*CHART_JSON_END/gs, '') 
                          .replace(/(?:(?:Bar Chart|Pie Chart|Line Chart)?\s*JSON Output:|\[Raw JSON from create_chart tool\])\s*\{(?:[^{}]|{(?:[^{}]|{[^{}]*})*})*\}/gi, '') 
                          .replace(/\{(?:[^{}]|{(?:[^{}]|{[^{}]*})*})*\}/g, (match) => {
                            try {
                              let cleanMatch = match
                                .replace(/\/\*[\s\S]*?\*\//g, '')
                                .replace(/\/\/.*$/gm, '')
                                .replace(/,\s*}/g, '}')
                                .replace(/,\s*]/g, ']');
                              const parsed = JSON.parse(cleanMatch);
                              if (parsed && (parsed.type || parsed.chart_type) && parsed.data && 
                                  ['bar', 'line', 'pie'].includes(parsed.type || parsed.chart_type)) {
                                return '';
                              }
                            } catch (e) {
                            }
                            return match;
                          })
                          .replace(/^\[|\]$/g, '') 
                          .trim();
                        return (
                          <>
                            {textWithoutChart && (
                              <ReactMarkdown
                                components={{
                                  code: renderCode,
                                  ...( { li: renderListItem } as any),
                                  input: renderInput,
                                  a: ({ ...props }) => (
                                    <TextLink type="external" href={props.href} target="_blank" >{props.children}</TextLink>
                                  )
                                } as any}
                                remarkPlugins={[remarkGfm]}
                                rehypePlugins={[rehypeRaw]}
                              >
                                {textWithoutChart}
                              </ReactMarkdown>
                            )}
                            {chartConfigs.map((chartConfig: any, index: number) => (
                              <div key={index}>
                                {renderChart(chartConfig)}
                              </div>
                            ))}
                          </>
                        );
                      } else {
                        return (
                              <ReactMarkdown
                                components={{
                                  code: renderCode,
                                  ...( { li: renderListItem } as any),
                                  input: renderInput,
                                  a: ({ ...props }) => (
                                    <TextLink type="external" href={props.href} target="_blank" >{props.children}</TextLink>
                                  )
                                } as any}
                            remarkPlugins={[remarkGfm]}
                            rehypePlugins={[rehypeRaw]}
                          >
                            {currentTypingText}
                          </ReactMarkdown>
                        );
                      }
                    })()}
                  </div>
                  <div className='text-right align-bottom pt-3 flex items-center justify-end gap-2'>
                    <Typography variant='body-small'>Typing...</Typography>
                    <button 
                      onClick={skipTyping}
                      className="text-blue-500 hover:text-blue-700 text-xs underline cursor-pointer"
                      type="button"
                    >
                      Skip
                    </button>
                  </div>
                </Widget>
              </div>
            )}
          </div>
        </div>

        <div className='n-bg-palette-neutral-bg-default border-t n-border-palette-neutral-border-weak p-4'>
          <form onSubmit={handleSubmit} className='flex gap-2.5 w-full'>
            <TextInput
              className='flex-1'
              value={inputMessage}
              isFluid
              isDisabled={isLoading}
              onChange={handleInputChange}
              htmlAttributes={{
                type: 'text',
                'aria-label': 'Chatbot Input',
                placeholder: isLoading ? 'Bot is thinking...' : 'Type your message...',
              }}
            />
            <Button type='submit' isDisabled={!inputMessage.trim() || isLoading}>
              Send
            </Button>
          </form>
        </div>

        <Modal
          modalProps={{
            id: 'default-menu',
            className: 'n-p-token-4 n-bg-palette-neutral-bg-weak n-rounded-lg min-w-[60%] max-h-[80%]',
          }}
          onClose={handleCloseModal}
          isOpen={isOpenModal}
        >
          <RetrievalInformation 
            sources={sourcesModal} 
            model={modelModal} 
            timeTaken={timeTaken}
            isMultiAgentMode={isMultiAgentMode}
            agentTasks={modalAgentTasks}
            userQuery={modalUserQuery}
          />
        </Modal>
      </div>
    </div>
  );
}
