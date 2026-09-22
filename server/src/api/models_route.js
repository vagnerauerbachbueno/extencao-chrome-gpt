import express from 'express';

const router = express.Router();

router.get('/models', (_req, res) => {
  res.json({
    object: 'list',
    data: [
      {
        id: 'agil-ai',
        object: 'model',
        owned_by: 'local-gateway'
      },
      {
        id: 'auto',
        object: 'model',
        owned_by: 'ai-router'
      }
    ]
  });
});

export default router;
