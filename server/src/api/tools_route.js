import express from 'express';

export function createToolsRouter(toolEngine) {
  const router = express.Router();

  router.get('/tools', (_req, res) => {
    const tools = toolEngine?.list?.() || [];

    res.json({
      object: 'list',
      data: tools.map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        parameters: tool.parameters || { type: 'object', properties: {} }
      }))
    });
  });

  return router;
}
