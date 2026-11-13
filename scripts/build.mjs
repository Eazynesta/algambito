import {mkdir, copyFile, writeFile} from 'node:fs/promises';
await mkdir('dist/server',{recursive:true});
await mkdir('dist/.openai',{recursive:true});
await copyFile('worker/index.js','dist/server/index.js');
await copyFile('.openai/hosting.json','dist/.openai/hosting.json');
await mkdir('public',{recursive:true});
await writeFile('public/robots.txt','User-agent: *\nDisallow: /api\n');
