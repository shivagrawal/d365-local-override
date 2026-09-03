const API='http://127.0.0.1:32145';
const $=id=>document.getElementById(id);
let state,timer,togglePending=false;

async function api(path,data){
  const slow=['/scan','/rules','/remove-rule','/enable','/disable'].includes(path);
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
function resourceLabel(path){ try{return new URL(path).pathname;}catch{return path;} }
function localLabel(p,root){
  if(root&&p.startsWith(root))return p.slice(root.length).replace(/^[\\/]/,'');
  const segments=p.split(/[\\/]/);
  const filename=segments.pop();
  // bundle.js / bundle.min.js is the same name for every PCF control - show
  // the containing control folder instead, or the caller sees indistinguishable entries.
  if(/^bundle(\.min)?\.js$/i.test(filename)&&segments.length){
    return `${segments.pop()} / ${filename}`;
  }
  return filename;
}

async function loadTabs(){
  const tabs=await api('/tabs');
  const sharedTabId=state?.rules?.[0]?.tabId;
  $('tab').replaceChildren(...tabs.map(t=>option(t.id,`${t.title||'Dynamics'} (${new URL(t.url).hostname})`)));
  if(sharedTabId&&tabs.some(t=>t.id===sharedTabId))$('tab').value=sharedTabId;
  if(!tabs.length)$('tab').append(option('','Open Dynamics in development Chrome'));
}

function renderStatus(status){
  const labels={idle:'Idle',off:'Override OFF',attached:'Interception attached — waiting for request',matched:'Dynamics resource matched',served:'Local file served','bundle-changed':'Local file changed',disconnected:'Chrome disconnected',error:'Interception failed'};
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

function renderRulesList(){
  const rules=state.rules||[];
  if(!rules.length){
    $('rulesList').innerHTML='';
    const empty=document.createElement('div');
    empty.className='empty-state';
    empty.textContent='No overrides yet';
    $('rulesList').append(empty);
    return;
  }
  $('rulesList').replaceChildren(...rules.map(rule=>{
    const row=document.createElement('div');
    row.className='override-row';

    const dot=document.createElement('span');
    dot.className='dot'+(state.connected?' on':'');

    const mapping=document.createElement('div');
    mapping.className='mapping';
    const remote=document.createElement('div');
    remote.textContent=resourceLabel(rule.resourceUrl);
    const local=document.createElement('div');
    local.className='local';
    local.textContent=`← ${localLabel(rule.bundlePath,state.projectRoot)}`;
    mapping.append(remote,local);

    const reload=document.createElement('input');
    reload.type='checkbox';
    reload.title='Auto reload on change';
    reload.checked=rule.autoReload!==false;
    reload.onchange=async()=>{
      try{state=await api('/rule-auto-reload',{ruleId:rule.id,enabled:reload.checked});render();}
      catch(e){showError(e.message)}
    };

    const remove=document.createElement('button');
    remove.className='row-action danger';
    remove.textContent='×';
    remove.title='Remove this override';
    remove.onclick=async()=>{
      try{state=await api('/remove-rule',{ruleId:rule.id});render();}
      catch(e){showError(e.message)}
    };

    row.append(dot,mapping,reload,remove);
    return row;
  }));
}

function render(){
  const script=state.resourceType==='script',html=state.resourceType==='html';
  $('localFileLabel').textContent=html?'Local HTML file':script?'Local JavaScript file':'Local bundle';
  $('dynamicsResourceLabel').textContent=html?'Dynamics HTML resource':script?'Dynamics JavaScript resource':'Dynamics bundle';
  $('scan').textContent=html?'Find HTML web resource':script?'Find JavaScript web resource':'Find Dynamics bundle';
  $('bundle').replaceChildren(...state.bundles.map(v=>option(v,localLabel(v,state.projectRoot))));
  if(!state.hasArtifact)$('bundle').append(option('','No local file selected yet'));
  if(state.hasArtifact&&!$('artifactPath').value)$('artifactPath').value=state.bundles[0];
  $('scan').disabled=!state.hasArtifact;
  if(!togglePending)$('override').checked=Boolean(state.connected);
  $('override').disabled=togglePending;

  renderRulesList();

  const count=state.rules?.length||0;
  $('statusDot').className='dot'+(state.connected?' on':count?'':' ');
  $('statusLine').textContent=count
    ?`${count} override${count===1?'':'s'} ${state.connected?'active':'configured'}`
    :'Helper connected';

  renderStatus(state.status);
  chrome.tabs.query({active:true,currentWindow:true}).then(([tab])=>tab?.id&&chrome.tabs.sendMessage(tab.id,{active:state.connected,resourceType:state.resourceType}).catch(()=>{}));
}

async function initialize(){
  try{
    state=await api('/status');
    $('offline').classList.add('hidden');$('online').classList.remove('hidden');
    await loadTabs();render();timer=setInterval(refreshStatus,1000);
    sendToNativeHost('watch-status').catch(()=>{});
    if(state.hasArtifact&&state.bundles?.length)detectWatch(state.bundles[0]);
  }catch{$('offline').classList.remove('hidden');$('online').classList.add('hidden');}
}
async function refreshStatus(){
  try{
    state=await api('/status');renderStatus(state.status);
    if(!togglePending)$('override').checked=state.connected;
    $('override').disabled=togglePending;
    renderRulesList();
    const count=state.rules?.length||0;
    $('statusDot').className='dot'+(state.connected?' on':'');
    $('statusLine').textContent=count?`${count} override${count===1?'':'s'} ${state.connected?'active':'configured'}`:'Helper connected';
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
  showError();
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
    chrome.tabs.query({active:true,currentWindow:true}).then(([tab])=>tab?.id&&chrome.tabs.sendMessage(tab.id,{active:false}).catch(()=>{}));
  }
  if(message.type==='error'){
    showNativeError(message.message);
  }
  if(message.type==='watch-detected'){
    watchState={...watchState,projectRoot:message.projectRoot,scripts:message.scripts||{},suggested:message.suggested};
    renderWatch();
    if(message.projectRoot&&message.suggested&&$('autoStartWatch').checked&&!watchState.running){
      sendToNativeHost('watch-start',{projectRoot:message.projectRoot,scriptName:message.suggested}).catch(()=>{});
    }
  }
  if(message.type==='watch-status'){
    watchState={...watchState,running:Boolean(message.running),log:message.log||watchState.log};
    if(message.projectRoot)watchState.projectRoot=message.projectRoot;
    renderWatch();
  }
});

async function copyCommand(button,command){
  await navigator.clipboard.writeText(command);
  const original=button.textContent;button.textContent='Copied';setTimeout(()=>button.textContent=original,1200);
}
function updateLaunchCommand(){
  const type=$('launchType').value,value=$('bundleFolder').value.trim().replace(/^"|"$/g,'');
  const flag=type==='html'?'--html':type==='script'?'--script':'--bundle';
  $('launchCommand').textContent=`pcf-local-override launch ${flag} "${value||'C:\\path\\to\\bundle-folder'}"`;
}
$('launchType').onchange=updateLaunchCommand;$('bundleFolder').oninput=updateLaunchCommand;
$('copy').onclick=e=>copyCommand(e.currentTarget,$('launchCommand').textContent);
$('refreshTabs').onclick=()=>loadTabs().catch(e=>showError(e.message));

$('addOverrideToggle').onclick=()=>{
  const opening=$('addPanel').classList.contains('hidden');
  $('addPanel').classList.toggle('hidden');
  $('addOverrideToggle').textContent=opening?'Cancel':'+ Add override';
  if(!opening){showError();$('candidates').replaceChildren();allCandidates=[];$('candidateFilter').classList.add('hidden');$('candidateFilter').value='';}
};

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
    chrome.storage?.local?.set({lastArtifactPath:value});
    if(state.hasArtifact)detectWatch(state.bundles[0]);
  }catch(e){showError(e.message)}
  finally{$('selectArtifact').disabled=false}
};

chrome.storage?.local?.get(['lastArtifactPath'],r=>{
  if(r.lastArtifactPath&&!$('artifactPath').value)$('artifactPath').value=r.lastArtifactPath;
});

// --- PCF build watch (npm run start:watch, automated instead of a manual terminal) ---
function stripAnsi(text){
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g,'');
}

let watchState={projectRoot:null,scripts:{},suggested:null,running:false,log:''};

function renderWatch(){
  const hasTarget=Boolean(watchState.projectRoot);
  $('watchTarget').classList.toggle('hidden',!hasTarget);
  $('watchScript').classList.toggle('hidden',!hasTarget);
  $('watchScriptLabel').classList.toggle('hidden',!hasTarget);
  $('startWatch').classList.toggle('hidden',!hasTarget||watchState.running);
  $('stopWatch').classList.toggle('hidden',!watchState.running);

  if(hasTarget){
    $('watchTarget').textContent=watchState.projectRoot;
    $('watchHint').textContent=watchState.running?'Running — this is the same build your bundle is served from.':'Detected. Start it here instead of a separate terminal.';
    const names=Object.keys(watchState.scripts);
    if(names.length){
      $('watchScript').replaceChildren(...names.map(n=>option(n,n)));
      $('watchScript').value=watchState.suggested&&names.includes(watchState.suggested)?watchState.suggested:names[0];
    }
  }else{
    $('watchHint').textContent='Detected automatically once you detect a local file above.';
  }

  const el=$('watchLog');
  const wasAtBottom=el.scrollTop+el.clientHeight>=el.scrollHeight-4;
  el.textContent=watchState.log?stripAnsi(watchState.log).slice(-4000):'Not running';
  if(wasAtBottom)el.scrollTop=el.scrollHeight;
}

async function detectWatch(bundlePath){
  if(!bundlePath)return;
  try{ await sendToNativeHost('watch-detect',{bundlePath}); }
  catch{ /* optional feature, fail quietly */ }
}

$('startWatch').onclick=async()=>{
  const scriptName=$('watchScript').value;
  if(!watchState.projectRoot||!scriptName)return;
  $('startWatch').disabled=true;
  try{
    const response=await sendToNativeHost('watch-start',{projectRoot:watchState.projectRoot,scriptName});
    if(!response?.ok)throw new Error(response?.error||'Could not reach the native host.');
  }catch(e){showError(e.message)}
  finally{$('startWatch').disabled=false}
};

$('stopWatch').onclick=async()=>{
  try{
    const response=await sendToNativeHost('watch-stop');
    if(!response?.ok)throw new Error(response?.error||'Could not reach the native host.');
  }catch(e){showError(e.message)}
};

chrome.storage?.local?.get(['autoStartWatch'],r=>{$('autoStartWatch').checked=Boolean(r.autoStartWatch);});
$('autoStartWatch').onchange=()=>{
  chrome.storage?.local?.set({autoStartWatch:$('autoStartWatch').checked});
};

let allCandidates=[];

function renderCandidates(filterText=''){
  const needle=filterText.trim().toLowerCase();
  const filtered=needle?allCandidates.filter(c=>c.url.toLowerCase().includes(needle)):allCandidates;
  $('candidates').replaceChildren();
  for(const c of filtered){
    const b=document.createElement('button');
    b.textContent=`${c.source}: ${new URL(c.url).pathname}`;
    b.onclick=()=>addOverride(c.url);
    $('candidates').append(b);
  }
  if(!filtered.length)$('candidates').textContent=allCandidates.length?'No matches for that filter.':'No candidates found.';
}

$('candidateFilter').oninput=()=>renderCandidates($('candidateFilter').value);

$('scan').onclick=async()=>{
  showError();$('candidates').textContent='Scanning…';$('candidateFilter').classList.add('hidden');
  try{
    allCandidates=await api('/scan',{tabId:$('tab').value,resourceType:state.resourceType});
    $('candidateFilter').value='';
    $('candidateFilter').classList.toggle('hidden',allCandidates.length<6);
    renderCandidates();
  }catch(e){showError(e.message)}
};

$('useResourceUrl').onclick=()=>{
  showError();
  const value=$('resourceUrl').value.trim();
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'||!/\.dynamics\.com$/i.test(url.hostname))throw new Error('Enter a complete Dynamics HTTPS resource URL.');
    addOverride(url.href);
  }catch(e){showError(e.message)}
};

async function addOverride(resourceUrl){
  const bundlePath=$('bundle').value;
  if(!bundlePath){
    showError('No local file is selected - click "Detect local file(s)" first.');
    console.error('[PatchPilot] addOverride aborted: #bundle has no value',{bundleOptions:[...$('bundle').options].map(o=>o.value)});
    return;
  }
  try{
    state=await api('/rules',{tabId:$('tab').value,bundlePath,resourceUrl});
    $('resourceUrl').value='';$('candidates').replaceChildren();allCandidates=[];
    $('addPanel').classList.add('hidden');$('addOverrideToggle').textContent='+ Add override';
    render();
  }catch(e){
    console.error('[PatchPilot] addOverride failed',{tabId:$('tab').value,bundlePath,resourceUrl,error:e});
    showError(e.message);
  }
}

$('override').onchange=async e=>{
  const requested=e.target.checked;togglePending=true;e.target.disabled=true;showError();
  try{state=await api(requested?'/enable':'/disable',{});render();}
  catch(x){e.target.checked=Boolean(state?.connected);showError(x.name==='TimeoutError'?'Override activation timed out. Check the helper and Chrome connection.':x.message)}
  finally{togglePending=false;e.target.disabled=false}
};

$('reload').onclick=()=>api('/reload',{tabId:$('tab').value}).catch(e=>showError(e.message));
initialize();
