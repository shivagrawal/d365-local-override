const API='http://127.0.0.1:32145';
const $=id=>document.getElementById(id);
let state,timer,togglePending=false;

async function api(path,data){
  const slow=['/scan','/configure','/enable','/disable'].includes(path);
  const response=await fetch(`${API}${path}`,{
    method:data?'POST':'GET',
    headers:data?{'Content-Type':'application/json'}:{},
    body:data?JSON.stringify(data):undefined,
    signal:AbortSignal.timeout(slow?10000:2500)
  });
  const body=await response.json();
  if(!response.ok)throw new Error(body.error||`Helper returned HTTP ${response.status}`);
  return body.result;
}
function showError(message=''){ $('error').textContent=message; $('error').classList.toggle('hidden',!message); }
function option(value,text){const o=document.createElement('option');o.value=value;o.textContent=text;return o;}

async function loadTabs(){
  const tabs=await api('/tabs');
  $('tab').replaceChildren(...tabs.map(t=>option(t.id,`${t.title||'Dynamics'} — ${new URL(t.url).hostname}`)));
  if(state?.config?.tabId&&tabs.some(t=>t.id===state.config.tabId))$('tab').value=state.config.tabId;
  if(!tabs.length)$('tab').append(option('','Open Dynamics in development Chrome'));
}

function renderStatus(status){
  const labels={idle:'Idle',off:'Override OFF',attached:'✓ Interception attached — waiting for request',matched:'✓ Dynamics resource matched',served:'✓ Local file served','bundle-changed':'✓ Local file changed',disconnected:'✕ Chrome disconnected',error:'✕ Interception failed'};
  const lines=[labels[status.stage]||status.stage];
  if(status.at)lines.push(new Date(status.at).toLocaleTimeString());
  if(status.size)lines.push(status.size<1048576?`${(status.size/1024).toFixed(1)} KB`:`${(status.size/1048576).toFixed(2)} MB`);
  if(status.modified)lines.push(`Build: ${new Date(status.modified).toLocaleString()}`);
  if(status.hash)lines.push(`Content: ${status.hash}`);
  if(status.target)lines.push(`Target: ${status.target}`);
  if(status.url)lines.push(new URL(status.url).pathname);
  if(status.message)lines.push(status.message);
  $('diagnostics').textContent=lines.join('\n');
}

function render(){
  const script=state.resourceType==='script',html=state.resourceType==='html';
  $('localFileLabel').textContent=html?'Local HTML file':script?'Local JavaScript file':'Local bundle';
  $('dynamicsResourceLabel').textContent=html?'Dynamics HTML resource':script?'Dynamics JavaScript resource':'Dynamics bundle';
  $('scan').textContent=html?'Find HTML web resource':script?'Find JavaScript web resource':'Find Dynamics bundle';
  $('project').textContent=state.projectRoot;
  $('bundle').replaceChildren(...state.bundles.map(v=>option(v,v.replace(`${state.projectRoot}\\`,''))));
  if(!state.hasArtifact)$('bundle').append(option('','No local file selected yet'));
  if(state.config?.bundlePath)$('bundle').value=state.config.bundlePath;
  if(state.hasArtifact&&!$('artifactPath').value)$('artifactPath').value=state.bundles[0];
  $('scan').disabled=!state.hasArtifact;
  $('resource').textContent=state.config?.rule?new URL(state.config.rule.selectedUrl).pathname:'Not configured';
  $('resource').classList.toggle('muted',!state.config?.rule);
  if(!togglePending)$('override').checked=Boolean(state.connected);
  $('override').disabled=togglePending;
  $('autoReload').checked=state.config?.autoReload!==false;
  $('active').classList.toggle('hidden',!state.connected);
  renderStatus(state.status);
  chrome.tabs.query({active:true,currentWindow:true}).then(([tab])=>tab?.id&&chrome.tabs.sendMessage(tab.id,{active:state.connected}).catch(()=>{}));
}

async function initialize(){
  try{
    state=await api('/status');
    $('offline').classList.add('hidden');$('online').classList.remove('hidden');
    await loadTabs();render();timer=setInterval(refreshStatus,1000);
  }catch{$('offline').classList.remove('hidden');$('online').classList.add('hidden');}
}
async function refreshStatus(){
  try{
    state=await api('/status');renderStatus(state.status);
    if(!togglePending)$('override').checked=state.connected;
    $('override').disabled=togglePending;$('active').classList.toggle('hidden',!state.connected);
  }catch{clearInterval(timer);$('offline').classList.remove('hidden');$('online').classList.add('hidden');}
}
function showNativeError(message=''){ $('nativeError').textContent=message; $('nativeError').classList.toggle('hidden',!message); }

async function sendToNativeHost(type,options,extra={}){
  return chrome.runtime.sendMessage({target:'pcf-native-host',type,options,...extra});
}

$('startHelper').onclick=async()=>{
  showNativeError();
  const type=$('launchType').value;
  const value=$('bundleFolder').value.trim().replace(/^"|"$/g,'');
  // A path is optional now: the helper can start bare and the artifact is
  // selected afterwards from the main panel.
  const options=value?{[type]:value}:{};
  $('startHelper').disabled=true;$('startHelper').textContent='Starting…';
  try{
    const response=await sendToNativeHost('start',options);
    if(!response?.ok)throw new Error(response?.error||'Could not reach the native host.');
  }catch(e){
    showNativeError(`${e.message} — see "Manual start" below if this is your first time.`);
  }finally{
    $('startHelper').disabled=false;$('startHelper').textContent='Start helper';
  }
};

$('stopHelper').onclick=async()=>{
  try{
    const response=await sendToNativeHost('stop');
    if(!response?.ok)throw new Error(response?.error||'Could not reach the native host.');
  }catch(e){showError(e.message)}
};

chrome.runtime.onMessage.addListener(message=>{
  if(message?.source!=='pcf-native-host')return;
  if(message.type==='picked'){
    if(message.cancelled)return;
    $('artifactPath').value=message.path;
    $('bundleFolder').value=message.path;
    if(message.applied&&message.snapshot){
      state=message.snapshot;render();showError();
    }else if(message.message){
      showError(message.message);
    }
    return;
  }
  if(message.type==='status'&&message.stage==='started'){
    setTimeout(()=>initialize().catch(()=>{}),500);
  }
  if(message.type==='status'&&message.stage==='stopped'){
    clearInterval(timer);
    $('online').classList.add('hidden');$('offline').classList.remove('hidden');
  }
  if(message.type==='error'){
    showNativeError(message.message);
  }
});

async function copyCommand(button,command){
  await navigator.clipboard.writeText(command);
  const original=button.textContent;button.textContent='Copied!';setTimeout(()=>button.textContent=original,1200);
}
function updateLaunchCommand(){
  const type=$('launchType').value,value=$('bundleFolder').value.trim().replace(/^"|"$/g,'');
  const flag=type==='html'?'--html':type==='script'?'--script':'--bundle';
  $('launchCommand').textContent=`pcf-local-override launch ${flag} "${value||'C:\\path\\to\\bundle-folder'}"`;
}
$('launchType').onchange=updateLaunchCommand;$('bundleFolder').oninput=updateLaunchCommand;
$('copy').onclick=e=>copyCommand(e.currentTarget,$('launchCommand').textContent);
$('refreshTabs').onclick=()=>loadTabs().catch(e=>showError(e.message));

async function browse(mode,targetInputId){
  const button=targetInputId==='bundleFolder'?$('browseStartFolder'):(mode==='folder'?$('browseFolder'):$('browseFile'));
  const original=button.textContent;
  button.disabled=true;button.textContent='Opening…';
  try{
    const response=await sendToNativeHost('pick',undefined,{mode});
    if(!response?.ok)throw new Error(response?.error||'Could not reach the native host.');
  }catch(e){
    const show=targetInputId==='bundleFolder'?showNativeError:showError;
    show(`${e.message} — paste the path manually instead.`);
  }finally{
    button.disabled=false;button.textContent=original;
  }
}

$('browseFolder').onclick=()=>browse('folder','artifactPath');
$('browseFile').onclick=()=>browse('file','artifactPath');
$('browseStartFolder').onclick=()=>browse('folder','bundleFolder');

$('selectArtifact').onclick=async()=>{
  showError();
  const value=$('artifactPath').value.trim().replace(/^"|"$/g,'');
  if(!value){showError('Enter or paste a local file or folder path.');return;}
  $('selectArtifact').disabled=true;
  try{
    state=await api('/artifact',{path:value});
    render();
  }catch(e){showError(e.message)}
  finally{$('selectArtifact').disabled=false}
};

$('scan').onclick=async()=>{
  showError();$('candidates').textContent='Scanning…';
  try{
    const candidates=await api('/scan',{tabId:$('tab').value,resourceType:state.resourceType});
    $('candidates').replaceChildren();
    for(const c of candidates){
      const b=document.createElement('button');
      b.textContent=`${c.source}: ${new URL(c.url).pathname}`;
      b.onclick=()=>configure(c.url);
      $('candidates').append(b);
    }
    if(!candidates.length)$('candidates').textContent='No candidates found.';
  }catch(e){showError(e.message)}
};

$('useResourceUrl').onclick=()=>{
  showError();
  const value=$('resourceUrl').value.trim();
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'||!/\.dynamics\.com$/i.test(url.hostname))throw new Error('Enter a complete Dynamics HTTPS resource URL.');
    configure(url.href);
  }catch(e){showError(e.message)}
};

async function configure(resourceUrl){
  try{
    await api('/configure',{tabId:$('tab').value,bundlePath:$('bundle').value,resourceUrl,autoReload:$('autoReload').checked});
    state=await api('/status');$('resource').textContent=new URL(resourceUrl).pathname;
    $('resource').classList.remove('muted');$('resourceUrl').value=resourceUrl;$('candidates').replaceChildren();render();
  }catch(e){showError(e.message)}
}

$('override').onchange=async e=>{
  const requested=e.target.checked;togglePending=true;e.target.disabled=true;showError();
  try{state=await api(requested?'/enable':'/disable',{});render();}
  catch(x){e.target.checked=Boolean(state?.connected);showError(x.name==='TimeoutError'?'Override activation timed out. Check the helper and Chrome connection.':x.message)}
  finally{togglePending=false;e.target.disabled=false}
};

$('autoReload').onchange=async e=>{
  try{state=await api('/auto-reload',{enabled:e.target.checked});render();}
  catch(x){showError(x.message)}
};

$('reload').onclick=()=>api('/reload',{tabId:$('tab').value}).catch(e=>showError(e.message));
initialize();
