// Built into the firmware so it always works, even with an empty or broken file system.
#pragma once

static const char ADMIN_PAGE[] = R"HTML(<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Buzzer Hub Admin</title>
<style>
:root{--bg:#0b0d1a;--panel:#151933;--line:#2b3163;--text:#f3f4ff;--muted:#9aa0c8;--accent:#ffcc00;--bad:#ff3b30;--ok:#34c759}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.4 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:16px}h1{margin:0 0 4px}h2{font-size:1.05rem;margin:0 0 8px}
section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:14px}
button,label.btn{background:#1d2246;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:.5rem .9rem;font:inherit;cursor:pointer;display:inline-block}
button.primary,label.btn{background:var(--accent);color:#111;border-color:var(--accent);font-weight:700}
input[type=file]{display:none}table{width:100%;border-collapse:collapse;font-size:.9rem}
td{padding:.3rem;border-bottom:1px solid var(--line)}td.n{text-align:right;color:var(--muted);white-space:nowrap}
.muted{color:var(--muted)}#log{white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:.85rem;max-height:200px;overflow:auto}
progress{width:100%}a{color:var(--accent)}
</style></head><body><main>
<h1>Buzzer Hub</h1>
<div class="muted" id="info">Loading…</div>
<p><a href="/">Open host console</a> · <a href="/display.html">Open studio display</a></p>

<section>
<h2>Web pages</h2>
<p class="muted">Select the <b>web</b> folder from the project. Every file inside is uploaded, keeping its sub-folders.</p>
<label class="btn" for="dir">Upload web folder</label><input type="file" id="dir" webkitdirectory multiple>
<label class="btn" for="one" style="background:#1d2246;color:var(--text);border-color:var(--line)">Upload single file</label><input type="file" id="one">
</section>

<section>
<h2>Firmware update</h2>
<p class="muted">Arduino IDE: Sketch → Export Compiled Binary, then pick <b>hub.ino.bin</b>. The hub restarts when done. Scores and pairings are kept.</p>
<label class="btn" for="fw">Upload firmware .bin</label><input type="file" id="fw" accept=".bin">
</section>

<section>
<h2>Progress</h2><progress id="prog" value="0" max="1"></progress><div id="log"></div>
</section>

<section>
<h2>Files</h2><table id="files"></table>
</section>
</main>
<script>
const $=id=>document.getElementById(id);
const log=m=>{$('log').textContent+=m+'\n';$('log').scrollTop=1e9};
function send(url,file,onProgress){return new Promise((res,rej)=>{const x=new XMLHttpRequest();x.open('POST',url);
x.upload.onprogress=e=>e.lengthComputable&&onProgress(e.loaded/e.total);x.onload=()=>x.status<300?res(x.responseText):rej(new Error(x.responseText||x.status));
x.onerror=()=>rej(new Error('network error'));const fd=new FormData();fd.append('file',file,file.name);x.send(fd)})}
async function uploadAll(list){const files=[...list];let i=0;for(const f of files){
let path=f.webkitRelativePath?'/'+f.webkitRelativePath.split('/').slice(1).join('/'):'/'+f.name;
if(path.split('/').some(p=>p.startsWith('.')))continue;
try{await send('/api/upload?path='+encodeURIComponent(path),f,p=>$('prog').value=(i+p)/files.length);log('ok   '+path)}
catch(e){log('FAIL '+path+': '+e.message)}i++}$('prog').value=1;load()}
$('dir').onchange=e=>uploadAll(e.target.files);
$('one').onchange=e=>{const f=e.target.files[0];if(!f)return;const p=prompt('Save as path on hub:','/'+f.name);if(p)send('/api/upload?path='+encodeURIComponent(p),f,v=>$('prog').value=v).then(()=>{log('ok   '+p);load()},err=>log('FAIL '+err.message))};
$('fw').onchange=async e=>{const f=e.target.files[0];if(!f)return;if(!confirm('Install '+f.name+' and restart the hub?'))return;
log('Uploading firmware…');try{await send('/api/update',f,v=>$('prog').value=v);log('Installed. Hub restarting; reload this page in 10 seconds.')}catch(err){log('FAIL '+err.message)}};
async function del(p){if(!confirm('Delete '+p+'?'))return;await fetch('/api/delete?path='+encodeURIComponent(p),{method:'POST'});load()}
async function load(){try{const r=await (await fetch('/api/files')).json();
$('info').textContent='Firmware '+r.version+' · storage '+(r.used/1048576).toFixed(1)+' of '+(r.total/1048576).toFixed(1)+' MB used';
$('files').innerHTML=r.files.sort((a,b)=>a.path.localeCompare(b.path)).map(f=>'<tr><td>'+f.path.replace(/</g,'&lt;')+'</td><td class="n">'+(f.size/1024).toFixed(1)+' KB</td><td class="n"><button data-p="'+encodeURIComponent(f.path)+'">Delete</button></td></tr>').join('')||'<tr><td class="muted">No files yet. Upload the web folder.</td></tr>';
$('files').querySelectorAll('button').forEach(b=>b.onclick=()=>del(decodeURIComponent(b.dataset.p)))}catch(e){$('info').textContent='Cannot reach hub: '+e.message}}
load();
</script></body></html>
)HTML";
