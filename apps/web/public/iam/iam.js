(() => {
  'use strict';
  const root = document.documentElement;
  const canvas = document.getElementById('energy-field');
  const toggle = document.getElementById('effects-toggle');
  const status = document.getElementById('effects-status');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const print = matchMedia('print');
  const mobile = matchMedia('(max-width: 699px)');
  const themes = {
    ember:{mode:0, hot:[1,.27,.025], warm:[1,.78,.38]},
    plasma:{mode:1, hot:[.52,.12,1], warm:[1,.43,.84]},
    ion:{mode:2, hot:[.015,.66,.72], warm:[.5,1,.8]}
  };
  let palette = 'ember';
  let enabled = true;
  let printing = false;
  try {
    const saved = localStorage.getItem('xedoc.iam.palette');
    if (Object.hasOwn(themes,saved)) palette = saved;
    enabled = localStorage.getItem('xedoc.iam.effects') !== 'off';
  } catch {}
  const active = () => enabled && !reduced.matches && !printing && !print.matches && !document.hidden;

  // A procedural flame/energy field. No video, textures, network assets or packages.
  const vertex = `attribute vec2 position;void main(){gl_Position=vec4(position,0.,1.);}`;
  const fragment = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    uniform vec2 resolution;
    uniform vec2 pointer;
    uniform float time;
    uniform float mode;
    uniform vec3 hot;
    uniform vec3 warm;
    float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
    float noise(vec2 p){
      vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
      return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);
    }
    float fbm(vec2 p){
      float v=0.;float a=.5;
      for(int i=0;i<4;i++){v+=a*noise(p);p=p*2.03+vec2(8.3,3.8);a*=.5;}return v;
    }
    void main(){
      vec2 uv=gl_FragCoord.xy/resolution;
      float aspect=resolution.x/resolution.y;
      vec2 p=vec2((uv.x-.5)*aspect,uv.y);
      float t=time*.35;
      float flow=fbm(vec2(p.x*3.1,p.y*3.8-t*1.8));
      float detail=fbm(vec2(p.x*6.4+flow*2.,p.y*5.2-t*2.3));
      float height=.34+flow*.31;
      float body=1.-smoothstep(height-.18,height+.08,p.y);
      float tongues=pow(max(0.,1.-abs(sin(p.x*5.8+flow*3.8+detail*2.))),2.8);
      float heat=body*(.16+tongues*.8)*(1.-smoothstep(.04,.9,p.y));
      float veil=exp(-abs(p.x-.28-sin(p.y*3.-t)*.18)*4.)*exp(-abs(p.y-.3)*4.)*.12;
      if(mode>.5&&mode<1.5){
        float band=abs(p.y-.32-sin(p.x*1.8+t*.3+flow)*.19);
        heat=exp(-band*14.)*(.2+detail*.65)+body*tongues*.22;
      }
      if(mode>1.5){
        float ribbon=abs(p.y-.27-sin(p.x*2.3-t*.22+flow)*.14);
        heat=exp(-ribbon*22.)*(.18+detail*.6)+body*tongues*.2;
      }
      vec2 sparkUV=vec2(uv.x*38.,uv.y*17.-time*.72);
      vec2 cell=floor(sparkUV),f=fract(sparkUV)-.5;
      f.x+=(hash(cell)-.5)*.5;
      float spark=exp(-dot(f*vec2(5.,1.9),f*vec2(5.,1.9))*110.)*step(.79,hash(cell+8.))*(1.-smoothstep(.06,.88,uv.y));
      float aura=exp(-length((uv-pointer)*vec2(aspect,1.))*4.5)*.055;
      vec3 color=hot*(heat*.72+veil+aura)+warm*(pow(heat,2.)*.48+spark*.8);
      color+=vec3(.008,.007,.006);
      gl_FragColor=vec4(color,1.);
    }`;

  function createRenderer() {
    const gl = canvas.getContext('webgl',{alpha:false,antialias:false,depth:false,stencil:false,powerPreference:'low-power',preserveDrawingBuffer:false});
    const state = {available:false,frames:0,running:false,theme:palette};
    if (!gl) return {state,refresh(){},pause(){}};
    function shader(type,source) {
      const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);
      if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){gl.deleteShader(s);return null;}return s;
    }
    const vs=shader(gl.VERTEX_SHADER,vertex),fs=shader(gl.FRAGMENT_SHADER,fragment);
    if(!vs||!fs)return {state,refresh(){},pause(){}};
    const program=gl.createProgram();gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);
    gl.deleteShader(vs);gl.deleteShader(fs);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))return {state,refresh(){},pause(){}};
    gl.useProgram(program);
    const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    const attribute=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(attribute);gl.vertexAttribPointer(attribute,2,gl.FLOAT,false,0,0);
    const uniforms={};['resolution','pointer','time','mode','hot','warm'].forEach(name=>{uniforms[name]=gl.getUniformLocation(program,name)});
    let frame=0,last=0,clock=8,lost=false;
    let pointerX=.7,pointerY=.35,targetX=.7,targetY=.35;
    function size() {
      const scale=mobile.matches ? 0.72 : 0.9;
      const dpr=Math.min(devicePixelRatio||1,1.5);
      const w=Math.round(innerWidth*dpr*scale),h=Math.round(innerHeight*dpr*scale);
      if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;gl.viewport(0,0,w,h);}
    }
    function draw() {
      if(lost)return;
      const theme=themes[palette];
      pointerX+=(targetX-pointerX)*.06;pointerY+=(targetY-pointerY)*.06;
      gl.uniform2f(uniforms.resolution,canvas.width,canvas.height);
      gl.uniform2f(uniforms.pointer,pointerX,pointerY);
      gl.uniform1f(uniforms.time,clock);gl.uniform1f(uniforms.mode,theme.mode);
      gl.uniform3fv(uniforms.hot,theme.hot);gl.uniform3fv(uniforms.warm,theme.warm);
      gl.drawArrays(gl.TRIANGLES,0,6);state.frames++;state.theme=palette;
    }
    function tick(stamp) {
      frame=0;
      if(!active()||lost){state.running=false;if(!lost)sync();return;}
      const interval=mobile.matches?1000/24:1000/30;
      if(!last||stamp-last>=interval){clock+=Math.min(last?(stamp-last)/1000:.033,.1);last=stamp;draw();}
      frame=requestAnimationFrame(tick);state.running=true;
    }
    function pause(){cancelAnimationFrame(frame);frame=0;last=0;state.running=false;}
    function refresh(){size();if(!active()){pause();draw();}else if(!frame){last=0;frame=requestAnimationFrame(tick);}}
    canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();lost=true;pause();canvas.style.opacity='0';});
    addEventListener('resize',refresh,{passive:true});
    addEventListener('pointermove',event=>{if(!mobile.matches){targetX=event.clientX/innerWidth;targetY=1-event.clientY/innerHeight;}},{passive:true});
    state.available=true;size();draw();
    return {state,refresh,pause};
  }
  const renderer=createRenderer();
  // Read-only counters used to verify that background work pauses correctly.
  window.iamFX={get status(){return {...renderer.state,enabled:active(),palette}}};

  function sync(announce=false) {
    const on=active();
    root.classList.toggle('fx-paused',!on);
    toggle.setAttribute('aria-pressed',String(enabled&&!reduced.matches));
    toggle.textContent=`Эффекты: ${enabled&&!reduced.matches?'вкл.':'выкл.'}`;
    if(!on&&typeof stopMotion==='function')stopMotion();
    if(announce)status.textContent=reduced.matches?'В настройках устройства включено уменьшение движения.':`Эффекты ${enabled?'включены':'выключены'}.`;
    renderer.refresh();
  }
  function selectPalette(name) {
    palette=name;root.dataset.theme=name;
    document.querySelectorAll('[data-palette]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.palette===name)));
    try{localStorage.setItem('xedoc.iam.palette',name)}catch{}
    renderer.refresh();
  }
  document.querySelectorAll('[data-palette]').forEach(button=>button.addEventListener('click',()=>selectPalette(button.dataset.palette)));
  toggle.addEventListener('click',()=>{
    enabled=!enabled;
    try{localStorage.setItem('xedoc.iam.effects',enabled?'on':'off')}catch{}
    sync(true);
  });
  reduced.addEventListener('change',()=>sync());
  print.addEventListener('change',()=>sync());
  document.addEventListener('visibilitychange',()=>sync());
  addEventListener('beforeprint',()=>{printing=true;sync()});
  addEventListener('afterprint',()=>{printing=false;sync()});

  const fxCards=document.querySelectorAll('.capabilities article,.job,.stack-card,.profile-card');
  fxCards.forEach(card=>{
    for(const name of ['edge-light','chrome-sheen']){
      const layer=document.createElement('span');layer.className=name;layer.setAttribute('aria-hidden','true');card.append(layer);
    }
  });
  if('IntersectionObserver' in window){
    const observer=new IntersectionObserver(entries=>entries.forEach(entry=>entry.target.classList.toggle('is-fx-visible',entry.isIntersecting)),{threshold:0});
    fxCards.forEach(card=>observer.observe(card));
    observer.observe(document.querySelector('.hero'));
  }
  let sparks=0;
  document.querySelector('main').addEventListener('pointerdown',event=>{
    if(!active()||sparks>=40||!event.target.closest('.interactive-surface'))return;
    const count=mobile.matches?5:9;
    for(let i=0;i<count;i++){
      const dot=document.createElement('span');dot.className='burst-spark';dot.setAttribute('aria-hidden','true');
      dot.style.left=`${event.clientX}px`;dot.style.top=`${event.clientY}px`;document.body.append(dot);sparks++;
      const angle=Math.PI*2*i/count;const distance=24+Math.random()*48;
      const a=dot.animate([{transform:'translate(0,0) scale(1)',opacity:1},{transform:`translate(${Math.cos(angle)*distance}px,${Math.sin(angle)*distance-24}px) scale(0)`,opacity:0}],{duration:650,easing:'cubic-bezier(.22,1,.36,1)'});
      const remove=()=>{dot.remove();sparks--};a.finished.then(remove,remove);
    }
  });
  selectPalette(palette);sync();
})();
