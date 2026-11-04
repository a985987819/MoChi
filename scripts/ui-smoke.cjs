async (page) => {
  await page.unrouteAll(); await page.setViewportSize({width:220,height:260}); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/src/pages/pet/main.tsx*', route => route.fulfill({ contentType: 'text/javascript', body: `
    import {mockIPC} from '/node_modules/@tauri-apps/api/mocks.js';
    import {emit} from '/node_modules/@tauri-apps/api/event.js';
    window.testEvents=[];
    mockIPC(cmd => {
      if(cmd==='list_user_pet_assets')return {};
      if(cmd==='plugin:store|load')return 1;
      if(cmd==='plugin:store|get')return [{providerId:'mock',petSelfName:'团团',userNickname:'小林'},true];
    },{shouldMockEvents:true});
    const original=window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke=(cmd,args)=>{if(cmd==='plugin:event|emit')window.testEvents.push(args.event);return original(cmd,args)};
    await import('/src/pages/pet/PetApp.tsx').then(async ({PetApp})=>{
      const dom=await import('/node_modules/.vite/deps/react-dom_client.js');const createRoot=dom.createRoot??dom.default.createRoot;
      const React=await import('/node_modules/.vite/deps/react.js');
      createRoot(document.getElementById('root')).render((React.createElement??React.default.createElement)(PetApp));
    });
  ` }));
  await page.goto('http://localhost:1420/');
  await page.locator('.pet-stage__img').waitFor(); const sprite=await page.locator('.pet-stage__img').boundingBox(); if(!sprite||sprite.width<190||sprite.height<230)throw new Error('sprite collapsed');
  await page.locator('.pet-stage').click({position:{x:100,y:130}});
  await page.waitForTimeout(600);
  await page.getByRole('status').waitFor();
  const bubble = page.getByRole('status');
  const bubbleBox = await bubble.boundingBox();
  if (!bubbleBox || bubbleBox.x < 0 || bubbleBox.y < 0 || bubbleBox.x + bubbleBox.width > 220 || bubbleBox.y + bubbleBox.height > 90) throw new Error('bubble clipped or covers face');
  if ((await bubble.innerText()).length < 5) throw new Error('bubble text missing');
  const bodyFits = await page.locator('.pet-bubble__text').evaluate(el => el.scrollHeight <= el.clientHeight + 1);
  if (!bodyFits) throw new Error('bubble text truncated');
  let events=await page.evaluate(()=>window.testEvents.splice(0));
  if(events.filter(e=>e==='ui://reset-standup').length!==1)throw new Error('single click failed '+events);
  // 使用页面实际加载的模块URL（含Vite HMR版本），避免测试另造一个无查询串的单例。
  const timerModuleUrl = await page.evaluate(() => performance.getEntriesByType('resource').map(entry=>entry.name).find(url=>/\/src\/services\/timers\.ts(?:\?|$)/.test(url)));
  if(!timerModuleUrl)throw new Error('timer module was not loaded');
  await page.evaluate(async timerUrl=>{
    const {pomodoroService}=await import(timerUrl);
    pomodoroService.startFocus(5);
  }, timerModuleUrl);
  await page.locator('.pet-stage').click({position:{x:100,y:130}});
  await page.waitForTimeout(600);
  const focusLine = await page.getByRole('status').innerText();
  const focusIsContextual = await page.evaluate(async text => {
    const {CHATTER_LINES}=await import('/src/services/pet-chatter-lines.ts');
    return CHATTER_LINES.filter(line=>line.category==='focus').some(line=>line.text.replaceAll('{pet}','团团').replaceAll('{user}','小林')===text);
  }, focusLine);
  if(!focusIsContextual)throw new Error('focus context was ignored');
  if(await page.getByRole('status').count()!==1)throw new Error('bubbles stacked');
  await page.getByRole('status').waitFor({state:'detached',timeout:9000});
  await page.evaluate(async timerUrl=>{const {pomodoroService}=await import(timerUrl);pomodoroService.stop();window.testEvents.splice(0);}, timerModuleUrl);
  await page.locator('.pet-stage').dblclick({position:{x:100,y:130}});
  await page.waitForTimeout(600);
  if (await page.getByRole('status').count()) throw new Error('double click left bubble visible');
  events=await page.evaluate(()=>window.testEvents.splice(0));
  if(events.filter(e=>e==='ui://open-chat').length!==1||events.includes('ui://reset-standup'))throw new Error('double click failed '+events);
  await page.locator('.pet-stage').click({button:'right',position:{x:100,y:130}});
  if (await page.getByRole('status').count()) throw new Error('menu left bubble visible');
  await page.getByRole('button',{name:'表情演示',exact:false}).click();
  await page.getByRole('button',{name:'happy',exact:true}).click();
  await page.waitForTimeout(600);
  events=await page.evaluate(()=>window.testEvents.splice(0));
  if(events.includes('ui://reset-standup')||events.includes('ui://drag-pet'))throw new Error('menu bubble '+events);
  await page.keyboard.press('Escape');await page.mouse.move(100,100);await page.mouse.down();await page.mouse.move(120,100);await page.mouse.up();
  await page.waitForTimeout(600);
  events=await page.evaluate(()=>window.testEvents.splice(0));
  if(!events.includes('ui://drag-pet')||events.includes('ui://reset-standup'))throw new Error('drag failed '+events);
  await page.route('**/src/pages/alert/main.tsx*',route=>route.fulfill({contentType:'text/javascript',body:`
    import {mockIPC} from '/node_modules/@tauri-apps/api/mocks.js';
    import {emit} from '/node_modules/@tauri-apps/api/event.js';
    window.testAlerts=[{id:'a',kind:'reminder',title:'到点喝水',body:'现在起身喝一杯水'},{id:'b',kind:'standup',title:'站立提醒',body:'伸展双腿'}];
    window.testAcks=[];
    mockIPC(async(cmd,args)=>{
      if(cmd==='get_app_alert')return window.testAlerts[0]??null;
      if(cmd==='ack_app_alert'){
        window.testAcks.push(args.id);window.testAlerts.shift();
        await emit('state://app-alert-changed',window.testAlerts[0]??null);
      }
    },{shouldMockEvents:true});
    const {AlertApp}=await import('/src/pages/alert/AlertApp.tsx');
    const dom=await import('/node_modules/.vite/deps/react-dom_client.js');const createRoot=dom.createRoot??dom.default.createRoot;
    const React=await import('/node_modules/.vite/deps/react.js');
    createRoot(document.getElementById('root')).render((React.createElement??React.default.createElement)(AlertApp));
  `}));
  await page.setViewportSize({width:320,height:200}); await page.goto('http://localhost:1420/alert.html');
  await page.getByText('现在起身喝一杯水').waitFor();
  await page.locator('.alert-shell').dblclick();
  await page.getByText('伸展双腿').waitFor();
  if((await page.evaluate(()=>window.testAcks)).length!==1)throw new Error('alert double ack');
  await page.waitForTimeout(600);
  await page.locator('.alert-shell').press('Enter');
  await page.waitForTimeout(100);
  if((await page.evaluate(()=>window.testAcks)).length!==2)throw new Error('alert enter ack');
  if(errors.length)throw new Error('browser errors '+errors.join(';'));
  return ('PASS: contextual bubble/custom names/viewport/no clipping/replacement/auto-dismiss, double-click and menu cancellation, menu isolation, drag intent, dynamic reminder content, cross-queue double click, keyboard acknowledgment; no page errors');
}
