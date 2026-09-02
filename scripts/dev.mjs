import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
const root=resolve('dist');
http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  const path=resolve(root,'.'+decodeURIComponent(pathname==='/'?'/index.html':pathname));
  const file=path===root?resolve(root,'index.html'):path;
  if(!file.startsWith(root+sep)){res.writeHead(403).end();return;}
  try{const data=await readFile(file);res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})[extname(file)]||'application/octet-stream');res.end(data);}catch{res.writeHead(404).end();}
}).listen(4173,'127.0.0.1',()=>console.log('SOF Studio http://127.0.0.1:4173'));
