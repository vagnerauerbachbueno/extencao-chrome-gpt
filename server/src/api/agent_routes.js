import { Router } from 'express';
import { AgentManager } from '../agents/agent_manager.js';
import { AIRouter } from '../core/router.js';

const router = Router();

const agents = new AgentManager();
const aiRouter = new AIRouter();

router.get('/agents', (_req, res) => {
  res.json({
    agents: agents.list()
  });
});

router.post('/responses', async (req, res) => {
  try {
    const payload = req.body || {};

    const result = await aiRouter.completion({
      provider: payload.provider || 'default',
      model: payload.model,
      messages: payload.messages || [],
      tools: payload.tools || []
    });

    res.json({
      id: `response_${Date.now()}`,
      object: 'response',
      choices: [
        {
          message: result
        }
      ]
    });
  } catch (error) {
    res.status(500).json({
      error: {
        message: error.message,
        type: 'server_error'
      }
    });
  }
});

export default router;
