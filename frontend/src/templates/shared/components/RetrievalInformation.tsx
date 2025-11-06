import { useEffect, useState } from 'react';

import { Box, Flex, Typography, GraphVisualization } from '@neo4j-ndl/react';
import { ClockIconOutline } from '@neo4j-ndl/react/icons';
import retrievalIllustration from '../assets/retrieval.png';
import { AgentTask } from '../types/Agent';

type NeoNode = {
  id: string;
  labels: string[];
  properties: Record<string, { stringified: string; type: string }>;
};

type NeoRel = {
  id: string;
  from: string;
  to: string;
  type: string;
  properties: Record<string, { stringified: string; type: string }>;
};

type RetrievalProps = {
  sources: Array<string>;
  model: string;
  timeTaken: number;
  isMultiAgentMode?: boolean;
  agentTasks?: AgentTask[];
  userQuery?: string;
};

function RetrievalInformation(props: RetrievalProps) {
  const [nodes, setNodes] = useState<NeoNode[]>([]);
  const [rels, setRels] = useState<NeoRel[]>([]);
  console.log("Retrieval info:");
  console.log("Sources:", props.sources);
  console.log("Query:", props.userQuery);

  function retrieveSources() {
    if (props.isMultiAgentMode && props.agentTasks && props.userQuery) {
      const nodes: NeoNode[] = [];
      const rels: NeoRel[] = [];
      let nodeId = 0;

      const questionId = `q_${nodeId}`;
      nodeId += 1;
      nodes.push({
        id: questionId,
        labels: ['Question'],
        properties: {
          question: {
            stringified: `"${props.userQuery.substring(0, 50)}..."`,
            type: 'string'
          }
        }
      });

      const orchestratorId = `ao_${nodeId}`;
      nodeId += 1;
      nodes.push({
        id: orchestratorId,
        labels: ['Agent', 'Orchestrator'],
        properties: {
          type: {
            stringified: '"Orchestrator"',
            type: 'string'
          }
        }
      });

      rels.push({
        id: `rel_${rels.length}`,
        from: questionId,
        to: orchestratorId,
        type: 'TRIGGERED',
        properties: {}
      });

      const uniqueAgents = new Map<string, string>();
      const agentNodeMap = new Map<string, string>();
      
      props.agentTasks
        .filter(task => !task.agentId.includes('supervisor') && !task.agentName.includes('Planner'))
        .forEach(task => {
          if (!uniqueAgents.has(task.agentId)) {
            uniqueAgents.set(task.agentId, task.agentName);
          }
        });

      uniqueAgents.forEach((agentName, agentId) => {
        const agentNodeId = `a_${nodeId}`;
        nodeId += 1;
        agentNodeMap.set(agentId, agentNodeId);
        
        nodes.push({
          id: agentNodeId,
          labels: ['Agent'],
          properties: {
            name: {
              stringified: `"${agentName}"`,
              type: 'string'
            },
            agentId: {
              stringified: `"${agentId}"`,
              type: 'string'
            },
            type: {
              stringified: `"${agentName}"`,
              type: 'string'
            }
          }
        });

        rels.push({
          id: `rel_${rels.length}`,
          from: orchestratorId,
          to: agentNodeId,
          type: 'USE_AGENT',
          properties: {}
        });
      });

      const createEntitiesFromAgentResult = (task: AgentTask, agentNodeId: string) => {
        const entities: NeoNode[] = [];
        const relationships: NeoRel[] = [];
        console.log("Tasks:")
        console.log(task);
        
        const resultId = `result_${nodeId}`;
        nodeId += 1;
        
        entities.push({
          id: resultId,
          labels: ['Result'],
          properties: {
            type: {
              stringified: `"${task.agentName} Output"`,
              type: 'string'
            },
            content: {
              stringified: `"${task.result}"`,
              type: 'string'
            },
            input: {
              stringified: `"${task.task || 'No input information available'}"`,
              type: 'string'
            },
            agent: {
              stringified: `"${task.agentName}"`,
              type: 'string'
            },
            status: {
              stringified: `"${task.status}"`,
              type: 'string'
            },
            taskDescription: {
              stringified: `"${task.task || 'Processing...'}"`,
              type: 'string'
            },
            taskId: {
              stringified: `"${task.id}"`,
              type: 'string'
            },
            completedAt: {
              stringified: task.endTime 
                ? `"${new Date(task.endTime).toLocaleTimeString()}"` 
                : '"N/A"',
              type: 'string'
            },
            processingTime: {
              stringified: task.startTime && task.endTime 
                ? `"${Math.round((task.endTime - task.startTime) / 1000)}s"` 
                : '"N/A"',
              type: 'string'
            }
          }
        });
        
        relationships.push({
          id: `rel_${rels.length + relationships.length}`,
          from: agentNodeId,
          to: resultId,
          type: 'PRODUCED',
          properties: {
            taskOrder: {
              stringified: `"Task ${task.id.replace(/\D/g, '')}"`,
              type: 'string'
            }
          }
        });

        if (task.agentName === 'Neo4J Agent' && task.graphData) {
          const graphData = task.graphData;
          const dataNodeId = `data_${nodeId}`;
          nodeId += 1;
          
          entities.push({
            id: dataNodeId,
            labels: ['Data', 'GraphRAG'],
            properties: {
              type: {
                stringified: '"GraphRAG Retrieved Data"',
                type: 'string'
              },
              query: {
                stringified: `"${graphData.query || 'GraphRAG Query'}"`,
                type: 'string'
              },
              cypherQuery: {
                stringified: `"${graphData.executed_cypher || 'N/A'}"`,
                type: 'string'
              },
              totalNodes: {
                stringified: `"${graphData.total_retrieved_nodes || 0}"`,
                type: 'string'
              },
              totalRelationships: {
                stringified: `"${graphData.total_retrieved_relationships || 0}"`,
                type: 'string'
              }
            }
          });
          
          relationships.push({
            id: `rel_${rels.length + relationships.length}`,
            from: resultId,
            to: dataNodeId,
            type: 'USED',
            properties: {}
          });
          
          const retrievedNodeMap = new Map<string, string>();
          
          if (graphData.retrieved_nodes && Array.isArray(graphData.retrieved_nodes)) {
            
            graphData.retrieved_nodes.forEach((node: any, idx: number) => {
              const retrievedNodeId = `retrieved_${nodeId}`;
              nodeId += 1;
              
              retrievedNodeMap.set(node.id, retrievedNodeId);
              
              const nodeLabels = node.labels || ['Node'];
              const primaryLabel = nodeLabels[0];
              
              entities.push({
                id: retrievedNodeId,
                labels: [primaryLabel, 'Retrieved'],
                properties: {
                  type: {
                    stringified: `"${primaryLabel}"`,
                    type: 'string'
                  },
                  elementId: {
                    stringified: `"${node.id || 'unknown'}"`,
                    type: 'string'
                  },
                  labels: {
                    stringified: `"${nodeLabels.join(', ')}"`,
                    type: 'string'
                  },
                  text: {
                    stringified: node.properties && node.properties.text 
                      ? `"${node.properties.text.substring(0, 100)}${node.properties.text.length > 100 ? '...' : ''}"` 
                      : '"No text available"',
                    type: 'string'
                  },
                  id: {
                    stringified: node.properties && node.properties.id 
                      ? `"${node.properties.id}"` 
                      : '"N/A"',
                    type: 'string'
                  },
                  name: {
                    stringified: node.properties && node.properties.name 
                      ? `"${node.properties.name}"` 
                      : node.properties && node.properties.text ? `"${node.properties.text}"`
                      : node.properties.fileName ? `"${node.properties.fileName}"` 
                      : node.properties.id ? `"${node.properties.id}"` : `"${primaryLabel} ${idx + 1}"`,
                    type: 'string'
                  }
                }
              });
              
              if (nodeLabels.includes('Movie')) {
                relationships.push({
                  id: `rel_${rels.length + relationships.length}`,
                  from: dataNodeId,
                  to: retrievedNodeId,
                  type: 'GRAPHRAG_RETRIEVED',
                  properties: {
                    order: {
                      stringified: `"${idx + 1}"`,
                      type: 'string'
                    }
                  }
                });
              }
            });
          }
          if (graphData.retrieved_relationships && Array.isArray(graphData.retrieved_relationships)) {
            
            graphData.retrieved_relationships.forEach((rel: any) => {
              const startNodeId = retrievedNodeMap.get(rel.start_node);
              const endNodeId = retrievedNodeMap.get(rel.end_node);
              
              if (startNodeId && endNodeId) {
                relationships.push({
                  id: `neo4j_rel_${rels.length + relationships.length}`,
                  from: startNodeId,
                  to: endNodeId,
                  type: rel.type || 'CONNECTED',
                  properties: {
                    originalType: {
                      stringified: `"${rel.type || 'UNKNOWN'}"`,
                      type: 'string'
                    },
                    elementId: {
                      stringified: `"${rel.id || 'unknown'}"`,
                      type: 'string'
                    },
                    ...(rel.properties ? Object.entries(rel.properties).reduce((acc, [key, value]) => {
                      acc[key] = {
                        stringified: `"${String(value)}"`,
                        type: 'string'
                      };
                      return acc;
                    }, {} as Record<string, { stringified: string; type: string }>) : {})
                  }
                });
              } else {
                console.warn('Skipping relationship - missing nodes:', {
                  startNodeFound: !!startNodeId,
                  endNodeFound: !!endNodeId,
                  start_node: rel.start_node,
                  end_node: rel.end_node
                });
              }
            });
            
            console.log('Final relationships count:', relationships.length);
          }
        }

        if (task.status === 'failed' && task.error) {
          const errorId = `error_${nodeId}`;
          nodeId += 1;
          
          entities.push({
            id: errorId,
            labels: ['Error'],
            properties: {
              type: {
                stringified: '"Processing Error"',
                type: 'string'
              },
              message: {
                stringified: `"${task.error}"`,
                type: 'string'
              },
              agent: {
                stringified: `"${task.agentName}"`,
                type: 'string'
              }
            }
          });
          
          relationships.push({
            id: `rel_${rels.length + relationships.length}`,
            from: agentNodeId,
            to: errorId,
            type: 'FAILED_WITH',
            properties: {}
          });
        }
        
        return { entities, relationships };
      };

      const resultNodeMap = new Map<string, string>();
      
      props.agentTasks
        .filter(task => !task.agentId.includes('supervisor') && !task.agentName.includes('Planner'))
        .forEach(task => {
          if (task.result || (task.status === 'failed' && task.error)) {
            const agentNodeId = agentNodeMap.get(task.agentId);
            if (agentNodeId) {
              const { entities, relationships } = createEntitiesFromAgentResult(task, agentNodeId);
              const resultNode = entities.find(entity => entity.labels.includes('Result'));
              if (resultNode) {
                resultNodeMap.set(task.id, resultNode.id);
              }
              
              nodes.push(...entities);
              rels.push(...relationships);
            }
          }
        });

      if (props.agentTasks) {
        props.agentTasks
          .filter(task => !task.agentId.includes('supervisor') && !task.agentName.includes('Planner'))
          .forEach(task => {
            if (task.input && task.input.includes('PREVIOUS AGENT RESULTS')) {
              const currentResultId = resultNodeMap.get(task.id);
              if (currentResultId) {
                const earlierTasks = props.agentTasks!
                  .filter(otherTask => 
                    !otherTask.agentId.includes('supervisor') && 
                    !otherTask.agentName.includes('Planner') &&
                    otherTask.id !== task.id &&
                    otherTask.result 
                  );

                earlierTasks.forEach(earlierTask => {
                  const earlierResultId = resultNodeMap.get(earlierTask.id);
                  if (earlierResultId) {
                    rels.push({
                      id: `collab_${rels.length}`,
                      from: currentResultId,
                      to: earlierResultId,
                      type: 'USED_INPUTS_FROM',
                      properties: {
                        collaboration: {
                          stringified: '"Agent Collaboration"',
                          type: 'string'
                        },
                        sourceAgent: {
                          stringified: `"${earlierTask.agentName}"`,
                          type: 'string'
                        },
                        targetAgent: {
                          stringified: `"${task.agentName}"`,
                          type: 'string'
                        },
                        description: {
                          stringified: `"${task.agentName} used results from ${earlierTask.agentName}"`,
                          type: 'string'
                        }
                      }
                    });
                  }
                });
              }
            }
          });
      }

      setNodes(nodes);
      setRels(rels);
    } else {
      const retrievedNodes = props.sources.map((source, index) => ({
        id: `${index}`,
        labels: ['Source'],
        properties: {
          source: {
            stringified: `"${source}"`,
            type: 'string'
          }
        }
      }));
      
      setNodes(retrievedNodes);
      
      if (retrievedNodes.length > 1) {
        setRels([{
          id: 'rel_0',
          from: '0',
          to: '1',
          type: 'MOCKUP_DATA',
          properties: {}
        }]);
      } else {
        setRels([]);
      }
    }
  }

  useEffect(() => {
    retrieveSources();
  }, [props.sources, props.isMultiAgentMode, props.agentTasks, props.userQuery]);

  return (
    <Box className='n-bg-palette-neutral-bg-weak p-4'>
      <Flex flexDirection='row' className='flex flex-row p-6 items-center'>
        <img src={retrievalIllustration} alt='icon' style={{ width: 95, height: 95, marginRight: 10 }} />
        <Box className='flex flex-col'>
          <Typography variant='h2'>Retrieval information</Typography>
          <Typography className='mb-2' variant='body-medium'>
            To generate this response, we used the model <span className='font-bold italic'>{props.model}</span>.
          </Typography>
        </Box>
      </Flex>
      <Box className='button-container flex justify-between mt-2'>
        <div style={{ height: '600px', width: '100%' }}>
          <GraphVisualization
            nodes={nodes}
            rels={rels}
            className="n-w-full n-border-palette-neutral-border-weak n-mx-2 n-rounded-lg n-border"
          />
        </div>
      </Box>
    </Box>
  );
}

export default RetrievalInformation;
