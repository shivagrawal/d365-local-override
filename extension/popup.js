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
      try{
        const removedPcfPath=rule.resourceType==='pcf'?rule.bundlePath:null;
        state=await api('/remove-rule',{ruleId:rule.id});
        render();
        // If that was the last PCF override for its project, its build watch
        // has nothing left to serve - stop it rather than leave webpack
        // running invisibly.
        if(removedPcfPath){
          const stillUsed=(state.rules||[]).some(r=>r.resourceType==='pcf'&&r.bundlePath===removedPcfPath);
          const projectRoot=Object.keys(watchTargets).find(p=>removedPcfPath.toLowerCase().startsWith(p.toLowerCase()));
          if(!stillUsed&&projectRoot){
            sendToNativeHost('watch-stop',{projectRoot}).catch(()=>{});
            delete watchTargets[projectRoot];
            delete liveWatches[projectRoot];
            renderWatch();
          }
        }
      }
      catch(e){showError(e.message)}
    };

    row.append(dot,mapping,reload,remove);
    return row;
  }));
}

function clientDeriveType(filePath){
  if(!filePath)return null;
  const ext=filePath.split('.').pop().toLowerCase();
  if(ext==='html'||ext==='htm')return'html';
  if(ext==='js')return/^bundle(\.min)?\.js$/i.test(filePath.split(/[\\/]/).pop())?'pcf':'script';
  return null;
}

function updateTypeLabels(){
  const type=clientDeriveType($('bundle').value)||state.resourceType;
  const script=type==='script',html=type==='html';
  $('localFileLabel').textContent=html?'Local HTML file':script?'Local JavaScript file':'Local bundle';
  $('dynamicsResourceLabel').textContent=html?'Dynamics HTML resource':script?'Dynamics JavaScript resource':'Dynamics bundle';
  $('scan').textContent=html?'Find HTML web resource':script?'Find JavaScript web resource':'Find Dynamics bundle';
}
$('bundle').onchange=updateTypeLabels;

function render(){
  $('bundle').replaceChildren(...state.bundles.map(v=>option(v,localLabel(v,state.projectRoot))));
  if(!state.hasArtifact)$('bundle').append(option('','No local file selected yet'));
  $('bundleFilter').classList.toggle('hidden',(state.bundles?.length||0)<6);
  // (path field is prefilled from per-type memory when the panel opens, not forced on every refresh)
  $('scan').disabled=!state.hasArtifact;
  updateTypeLabels();
  if(!togglePending)$('override').checked=Boolean(state.connected);
  $('override').disabled=togglePending;

  renderRulesList();

  const count=state.rules?.length||0;
  $('statusDot').className='dot'+(state.connected?' on':count?'':' ');
  $('statusLine').textContent=count
    ?`${count} override${count===1?'':'s'} ${state.connected?'active':'configured'}`
    :'Connected';

  renderStatus(state.status);
  const activeTypes=new Set((state.rules||[]).map(r=>r.resourceType));
  const badgeType=activeTypes.size===1?[...activeTypes][0]:undefined;
  chrome.tabs.query({url:'https://*.dynamics.com/*'}).then(tabs=>tabs.forEach(t=>chrome.tabs.sendMessage(t.id,{active:state.connected,resourceType:badgeType}).catch(()=>{})));
}

/** The build watch belongs to the PCF override that's actually ACTIVE, not
 * to whatever folder was last browsed for staging. Using the staged artifact
 * meant browsing a different project (to add another override) silently
 * re-pointed the watch at that project instead of the one being served. */
function activePcfBundlePath(){
  return (state?.rules||[]).find(r=>r.resourceType==='pcf')?.bundlePath||null;
}

/** Ask the host to detect the project for every active PCF override. */
function detectAllPcfWatches(){
  for(const rule of (state?.rules||[])){
    if(rule.resourceType==='pcf')detectWatch(rule.bundlePath);
  }
}

async function initialize(){
  try{
    state=await api('/status');
    $('offline').classList.add('hidden');$('online').classList.remove('hidden');
    await loadTabs();render();timer=setInterval(refreshStatus,1000);
    sendToNativeHost('watch-status').catch(()=>{});
    detectAllPcfWatches();
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
    $('statusLine').textContent=count?`${count} override${count===1?'':'s'} ${state.connected?'active':'configured'}`:'Connected';
    sendToNativeHost('watch-status').catch(()=>{});
    renderWatch();
  }catch{clearInterval(timer);$('offline').classList.remove('hidden');$('online').classList.add('hidden');}
}
function showNativeError(message=''){ $('nativeError').textContent=message; $('nativeError').classList.toggle('hidden',!message); }

async function sendToNativeHost(type,options,extra={}){
  return chrome.runtime.sendMessage({target:'pcf-native-host',type,options,...extra});
}

$('startHelper').onclick=async()=>{
  showNativeError();
  $('startHelper').disabled=true;$('startHelper').textContent='Connecting…';
  try{
    const response=await sendToNativeHost('start',{});
    if(!response?.ok)throw new Error(response?.error||'Could not reach the native host.');
  }catch(e){
    showNativeError(`${e.message} — see "First-time setup" below if this is your first time.`);
  }finally{
    $('startHelper').disabled=false;$('startHelper').textContent='Connect';
  }
};

$('stopHelper').onclick=async()=>{
  showError();
  $('stopHelper').disabled=true;$('stopHelper').textContent='Disconnecting…';
  try{
    // Each browser window's extension has its OWN native host process, so a
    // Disconnect clicked in the dev window reaches a host that never started
    // anything. Ask the running helper over HTTP as well - whichever window
    // this is, that reaches the one helper that actually owns the session.
    await sendToNativeHost('stop').catch(()=>{});
    await api('/shutdown',{}).catch(()=>{});
  }catch(e){showError(e.message)}
  finally{
    $('stopHelper').disabled=false;$('stopHelper').textContent='Disconnect';
    clearInterval(timer);
    $('online').classList.add('hidden');$('offline').classList.remove('hidden');
    chrome.tabs.query({url:'https://*.dynamics.com/*'}).then(tabs=>tabs.forEach(t=>chrome.tabs.sendMessage(t.id,{active:false}).catch(()=>{})));
  }
};

chrome.runtime.onMessage.addListener(message=>{
  if(message?.source!=='pcf-native-host')return;
  if(message.type==='picked'){
    if(message.cancelled)return;
    $('artifactPath').value=message.path;
    // (offline screen no longer has a path input)
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
    chrome.tabs.query({url:'https://*.dynamics.com/*'}).then(tabs=>tabs.forEach(t=>chrome.tabs.sendMessage(t.id,{active:false}).catch(()=>{})));
  }
  if(message.type==='error'){
    showNativeError(message.message);
    // The native host can die while the helper it launched is still alive and
    // serving (they're separate processes). Re-check rather than leaving the
    // UI stuck on an error for a session that's actually working.
    setTimeout(()=>initialize().catch(()=>{}),400);
  }
  if(message.type==='watch-detected'){
    if(message.projectRoot){
      const key=message.projectRoot;
      watchTargets[key]={projectRoot:key,scripts:message.scripts||{},suggested:message.suggested};
    }
    renderWatch();
  }
  if(message.type==='watch-status'){
    // The pool reports every tracked project; merge running-state into
    // whatever detection info we already have per project.
    liveWatches={};
    for(const w of (message.watches||[])){
      if(w.projectRoot)liveWatches[w.projectRoot]={running:w.running,log:w.log||'',scriptName:w.scriptName};
    }
    renderWatch();
  }
});

async function copyCommand(button,command){
  await navigator.clipboard.writeText(command);
  const original=button.textContent;button.textContent='Copied';setTimeout(()=>button.textContent=original,1200);
}
$('copy').onclick=e=>copyCommand(e.currentTarget,$('launchCommand').textContent);
$('refreshTabs').onclick=()=>loadTabs().catch(e=>showError(e.message));

const TYPE_HINTS={
  pcf:"Point this at any folder - it'll be searched for PCF bundles.",
  script:"Point this at your web resources folder - it'll be searched for .js files (PCF bundles excluded).",
  html:"Point this at your web resources folder - it'll be searched for .html files."
};

function currentType(){ return $('overrideType').value; }

$('overrideType').onchange=()=>{
  $('artifactHint').textContent=TYPE_HINTS[currentType()];
  // Each type usually lives in a different folder, so remember paths per type
  // rather than carrying one folder across all three.
  chrome.storage?.local?.get(['lastPathByType'],r=>{
    $('artifactPath').value=(r.lastPathByType||{})[currentType()]||'';
  });
  $('bundle').replaceChildren();
  $('bundleFilter').classList.add('hidden');
  $('candidates').replaceChildren();
  allCandidates=[];
  $('candidateFilter').classList.add('hidden');
};

$('addOverrideToggle').onclick=()=>{
  const opening=$('addPanel').classList.contains('hidden');
  $('addPanel').classList.toggle('hidden');
  $('addOverrideToggle').textContent=opening?'Cancel':'+ Add override';
  if(opening){
    $('artifactHint').textContent=TYPE_HINTS[currentType()];
    chrome.storage?.local?.get(['lastPathByType'],r=>{
      if(!$('artifactPath').value)$('artifactPath').value=(r.lastPathByType||{})[currentType()]||'';
    });
  }else{
    showError();$('candidates').replaceChildren();allCandidates=[];
    $('candidateFilter').classList.add('hidden');$('candidateFilter').value='';
  }
};

async function browse(mode){
  const button=mode==='folder'?$('browseFolder'):$('browseFile');
  const original=button.textContent;
  button.disabled=true;button.textContent='Opening…';
  try{
    const response=await sendToNativeHost('pick',undefined,{mode,resourceType:currentType()});
    if(!response?.ok)throw new Error(response?.error||'Could not reach the native host.');
  }catch(e){
    showError(`${e.message} — paste the path manually instead.`);
  }finally{
    button.disabled=false;button.textContent=original;
  }
}

$('browseFolder').onclick=()=>browse('folder');
$('browseFile').onclick=()=>browse('file');

$('selectArtifact').onclick=async()=>{
  showError();
  const value=$('artifactPath').value.trim().replace(/^"|"$/g,'');
  if(!value){showError('Enter or paste a folder or file path.');return;}
  const type=currentType();
  $('selectArtifact').disabled=true;
  try{
    state=await api('/artifact',{path:value,resourceType:type});
    render();
    chrome.storage?.local?.get(['lastPathByType'],r=>{
      chrome.storage?.local?.set({lastPathByType:{...(r.lastPathByType||{}),[type]:value}});
    });
  }catch(e){showError(e.message)}
  finally{$('selectArtifact').disabled=false}
};

// A solution folder can hold many JS web resources - let the list be filtered.
$('bundleFilter').oninput=()=>{
  const needle=$('bundleFilter').value.trim().toLowerCase();
  const matches=needle?state.bundles.filter(b=>b.toLowerCase().includes(needle)):state.bundles;
  $('bundle').replaceChildren(...matches.map(v=>option(v,localLabel(v,state.projectRoot))));
  if(!matches.length)$('bundle').append(option('','No matches for that filter'));
  updateTypeLabels();
};

// (per-type path restore happens when the add panel opens / type changes)

// --- PCF build watch (npm run start:watch, automated instead of a manual terminal) ---
function stripAnsi(text){
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g,'');
}

let watchTargets={};   // projectRoot -> { projectRoot, scripts, suggested }
let liveWatches={};    // projectRoot -> { running, log, scriptName }

/** Every distinct project root across all active PCF overrides. */
function activePcfProjects(){
  return [...new Set(Object.keys(watchTargets))];
}

function renderWatch(){
  // The section exists only when a PCF override is actually active - JS and
  // HTML web resources have no build step, so a build watch is meaningless
  // for them and shouldn't occupy screen space.
  const projects=activePcfBundlePath()?activePcfProjects():[];
  $('watchSection').classList.toggle('hidden',!projects.length);
  if(!projects.length){ $('watchList').replaceChildren(); return; }

  const runningCount=projects.filter(p=>liveWatches[p]?.running).length;
  $('watchStateLabel').textContent=runningCount?`● ${runningCount} running`:'○ Stopped';
  $('watchStateLabel').style.color=runningCount?'var(--amber)':'var(--text-faint)';

  // Remove rows for projects that are no longer active (override removed).
  for(const existing of [...$('watchList').children]){
    if(!projects.includes(existing.dataset.project))existing.remove();
  }

  for(const projectRoot of projects){
    const target=watchTargets[projectRoot]||{scripts:{},suggested:null};
    const live=liveWatches[projectRoot]||{running:false,log:''};
    let row=[...$('watchList').children].find(c=>c.dataset.project===projectRoot);

    if(!row){
      // Build the row once. Rebuilding it on every refresh would reset the
      // script <select> and collapse an expanded log while the user reads it.
      row=document.createElement('div');
      row.className='watch-row';
      row.dataset.project=projectRoot;

      const head=document.createElement('div');
      head.className='watch-head';
      const dot=document.createElement('span');
      dot.className='dot';
      const name=document.createElement('span');
      name.className='watch-name';
      name.textContent=projectRoot.split(/[\\/]/).filter(Boolean).pop()||projectRoot;
      name.title=projectRoot;
      head.append(dot,name);

      const scriptSelect=document.createElement('select');
      const button=document.createElement('button');
      button.className='secondary-button full-width';

      const logBox=document.createElement('details');
      const summary=document.createElement('summary');
      summary.textContent='Build watch log';
      const logView=document.createElement('div');
      logView.className='log-panel';
      logBox.append(summary,logView);

      button.onclick=async()=>{
        const isRunning=Boolean(liveWatches[projectRoot]?.running);
        button.disabled=true;
        try{
          const response=isRunning
            ? await sendToNativeHost('watch-stop',{projectRoot})
            : await sendToNativeHost('watch-start',{projectRoot,scriptName:scriptSelect.value});
          if(!response?.ok)throw new Error(response?.error||'Could not reach the native host.');
        }catch(e){showError(e.message)}
        finally{button.disabled=false}
      };

      row.append(head,scriptSelect,button,logBox);
      $('watchList').append(row);
    }

    // Update in place, leaving user interaction state (selection, expanded
    // log, scroll position) untouched.
    const [head,scriptSelect,button,logBox]=row.children;
    head.firstChild.className='dot'+(live.running?' on':'');

    const names=Object.keys(target.scripts);
    const existingOptions=[...scriptSelect.options].map(o=>o.value);
    if(names.length&&String(existingOptions)!==String(names)){
      const previous=scriptSelect.value;
      scriptSelect.replaceChildren(...names.map(n=>option(n,n)));
      scriptSelect.value=names.includes(previous)?previous
        :(target.suggested&&names.includes(target.suggested)?target.suggested:names[0]);
    }
    scriptSelect.disabled=live.running;
    button.textContent=live.running?'Stop build watch':'Start build watch';

    const logView=logBox.lastChild;
    const nextLog=live.log?stripAnsi(live.log).slice(-4000):'Not running';
    if(logView.textContent!==nextLog){
      const wasAtBottom=logView.scrollTop+logView.clientHeight>=logView.scrollHeight-4;
      logView.textContent=nextLog;
      if(wasAtBottom)logView.scrollTop=logView.scrollHeight;
    }
  }
}

async function detectWatch(bundlePath){
  if(!bundlePath)return;
  try{ await sendToNativeHost('watch-detect',{bundlePath}); }
  catch{ /* optional feature, fail quietly */ }
}

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
    allCandidates=await api('/scan',{tabId:$('tab').value,bundlePath:$('bundle').value});
    $('candidateFilter').value='';
    $('candidateFilter').classList.toggle('hidden',allCandidates.length<6);
    renderCandidates();
  }catch(e){showError(e.message)}
};

async function addOverride(resourceUrl){
  const bundlePath=$('bundle').value;
  if(!bundlePath){
    showError('No local file is selected - click "Find local files" first.');
    console.error('[PatchPilot] addOverride aborted: #bundle has no value',{bundleOptions:[...$('bundle').options].map(o=>o.value)});
    return;
  }
  try{
    state=await api('/rules',{tabId:$('tab').value,bundlePath,resourceUrl});
    $('candidates').replaceChildren();allCandidates=[];
    $('addPanel').classList.add('hidden');$('addOverrideToggle').textContent='+ Add override';
    render();
    // Detect the build watch target only now - when a PCF override actually
    // becomes active - rather than when a folder was merely browsed.
    detectAllPcfWatches();
  }catch(e){
    console.error('[PatchPilot] addOverride failed',{tabId:$('tab').value,bundlePath,resourceUrl,error:e});
    showError(e.message);
  }
}

$('override').onchange=async e=>{
  const requested=e.target.checked;togglePending=true;e.target.disabled=true;showError();
  try{
    state=await api(requested?'/enable':'/disable',{});
    // Clear the guard BEFORE rendering: render() skips updating the checkbox
    // while togglePending is set, so rendering inside the guarded window left
    // the checkbox showing whatever the browser had set, never synced from
    // the actual server response.
    togglePending=false;
    render();
  }catch(x){
    togglePending=false;
    e.target.checked=Boolean(state?.connected);
    showError(x.name==='TimeoutError'?'Override activation timed out. Check the helper and Chrome connection.':x.message);
  }
  finally{togglePending=false;e.target.disabled=false}
};

$('reload').onclick=()=>api('/reload',{tabId:$('tab').value}).catch(e=>showError(e.message));
initialize();
