// Renderer evaluation for the seven-scene layout comparison. Only the storyboard
// caption, position and timing cross the template boundary. No source image input.
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const [input, output, gsapFile] = process.argv.slice(2);
const data = JSON.parse(await readFile(input,'utf8'));
const scenes = data.scenes;
if (!Array.isArray(scenes) || scenes.length !== 7) throw new Error('Expected seven reviewed scenes.');
const escape = text => text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const stops = [0];
const captions = scenes.map(({position, caption, duration_sec}, index) => {
  if (position !== index+1 || typeof caption !== 'string' || !caption.trim() || caption.length > 60
      || !Number.isInteger(duration_sec) || duration_sec < 3 || duration_sec > 15) throw new Error('Invalid storyboard scene.');
  const start = stops.at(-1);
  stops.push(start+duration_sec);
  // The persistent disclosure is the first caption, so don't put it on screen twice.
  if (index === 0 && caption === 'Synthetic QA fixture · Illustrative example') return '';
  return `<p class="caption clip" data-start="${start}" data-duration="${duration_sec}" data-track-index="1">${escape(caption)}</p>`;
});
const defaults = {colour_text:'#192925', colour_accent:'#D8EDB4', colour_primary:'#142B23', colour_background:'#F5F7F3'};
const colour = key => /^#[0-9a-f]{6}$/i.test(data.brand?.[key]) ? data.brand[key] : defaults[key];
const palette = `:root{--ink:${colour('colour_text')};--accent:${colour('colour_accent')};--primary:${colour('colour_primary')};--paper:${colour('colour_background')}}`;
const template = await readFile(new URL('./workspace-reel.html',import.meta.url),'utf8');
const html = template.replace('<style>', '<style>'+palette)
  .replace('data-duration="DURATION"',`data-duration="${stops.at(-1)}"`)
  .replace('STOPS',JSON.stringify(stops)).replace('CAPTIONS',()=>captions.join('\n'));
await mkdir(output,{recursive:true});
await copyFile(gsapFile,path.join(output,'gsap.min.js'));
await writeFile(path.join(output,'index.html'),html);
