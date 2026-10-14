import 'dotenv/config';
import app from './app.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`MATISTA API funcionando en http://localhost:${PORT}`);
});