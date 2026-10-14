import { publicConfigIsValid } from '../src/security.js';
if(process.env.VITE_APP_MODE!=='production'||!publicConfigIsValid({url:process.env.VITE_SUPABASE_URL,anonKey:process.env.VITE_SUPABASE_PUBLISHABLE_KEY})){
  console.error('Publicación detenida: configura VITE_APP_MODE=production y la URL y clave pública de Supabase.');process.exitCode=1;
}
