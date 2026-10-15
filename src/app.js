import express from 'express';
import cors from 'cors';
import { errorHandler } from './shared/errors/error-handler.js';

const app = express();

app.use(cors({
  origin: 'http://localhost:5173',
}));

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    application: 'MATISTA',
    service: 'backend',
  });
});

app.use(errorHandler);

export default app;
