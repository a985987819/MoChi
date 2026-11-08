/**
 * 更新界面浏览器回归：真实 ChatApp/SettingsTab + Tauri 官方 mockIPC。
 * 仅替换 IPC 和网络边界；不下载、不安装，也不访问实际发布服务。
 * 用法：playwright-cli -s=mochi-updates run-code --filename scripts/update-smoke.cjs
 */
async (page) => {
  await page.unrouteAll();
  await page.setViewportSize({ width: 420, height: 560 });
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  try {
    await page.route('**/src/pages/chat/main.tsx*', route => route.fulfill({
      contentType: 'text/javascript', body: `
        import {mockIPC} from '/node_modules/@tauri-apps/api/mocks.js';
        window.updateScenario = 'available';
        window.updateRequests = 0;
        window.updateAborts = 0;
        window.openedUpdateUrls = [];
        window.rejectUpdateOpener = false;
        Object.defineProperty(navigator, 'platform', {configurable:true, value:'Win32'});
        mockIPC(async (cmd,args) => {
          if(cmd==='plugin:store|load') return 1;
          if(cmd==='plugin:store|get') return [{providerId:'mock',onboardingDone:true},true];
          if(cmd==='plugin:app|version') return '0.9.0';
          if(cmd==='plugin:path|resolve_directory') return 'C:/mock/Mochi';
          if(cmd==='plugin:sql|load') return 'sqlite:mochi.db';
          if(cmd==='plugin:sql|execute') return [0,0];
          if(cmd==='plugin:sql|select') return [];
          if(cmd==='plugin:notification|is_permission_granted') return true;
          if(cmd==='plugin:opener|open_url') {
            window.openedUpdateUrls.push(args.url);
            if(window.rejectUpdateOpener) throw new Error('mock browser unavailable');
          }
        }, {shouldMockEvents:true});
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input,init) => {
          const url = String(input);
          if(!url.startsWith('https://api.github.com/')) return originalFetch(input,init);
          window.updateRequests++;
          if(window.updateScenario==='offline') throw new TypeError('mock offline');
          if(window.updateScenario==='pending') return new Promise((resolve,reject)=> {
            init.signal.addEventListener('abort',()=> {window.updateAborts++; reject(new DOMException('aborted','AbortError'));}, {once:true});
          });
          if(window.updateScenario==='unpublished') return new Response('{}',{status:404});
          const version = window.updateScenario==='ahead' ? '0.8.2' : '0.10.0';
          const name = 'Mochi_'+version+'_x64-setup.exe';
          const data = {tag_name:'v'+version,name:'Mochi v'+version,draft:false,prerelease:false,
            body:'改进提醒和启动体验。\\n保留聊天、待办和自定义素材。\\n<img src=x onerror=alert(1)>',
            published_at:'2026-11-06T01:00:00Z', assets:window.updateScenario==='missing' ? [] : [{
              name,size:3000000,browser_download_url:'https://github.com/a985987819/MoChi/releases/download/v'+version+'/'+name
            }]};
          return new Response(JSON.stringify(data), {headers:{'Content-Type':'application/json'}});
        };
        const {ChatApp}=await import('/src/pages/chat/ChatApp.tsx');
        const dom=await import('/node_modules/.vite/deps/react-dom_client.js');
        const React=await import('/node_modules/.vite/deps/react.js');
        (dom.createRoot??dom.default.createRoot)(document.getElementById('root')).render((React.createElement??React.default.createElement)(ChatApp));
      `,
    }));
    await page.goto('http://localhost:1420/chat.html');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const section = page.getByRole('region', { name: '版本与更新', exact: true });
    await section.getByText('v0.9.0', { exact: true }).waitFor();
    // 仅收集这次已安装mocks后的页面错误，不继承旧页面首次无IPC加载的历史记录。
    if (errors.length) throw new Error('mocked page failed to initialize: ' + errors.join('; '));
    if (await page.evaluate(() => window.updateRequests) !== 0) throw new Error('update checked without user action');
    const box = await section.getByRole('button', { name: '检查更新', exact: true }).boundingBox();
    if (!box || box.x < 0 || box.x + box.width > 420 || box.y < 0 || box.y + box.height > 560) throw new Error('check button outside first viewport');
    await page.screenshot({ path: '.playwright-cli/updates-idle-420.png' });

    await section.getByRole('button', { name: '检查更新', exact: true }).click();
    await section.getByText('发现新版本 v0.10.0', { exact: true }).waitFor();
    const notes = section.getByRole('region', { name: 'v0.10.0 更新说明正文', exact: true });
    if (!(await notes.innerText()).includes('保留聊天、待办')) throw new Error('release notes missing');
    if (await notes.locator('img').count()) throw new Error('remote notes rendered as HTML');
    await notes.focus();
    if (!(await notes.evaluate(element => element === document.activeElement))) throw new Error('scrollable notes not keyboard focusable');
    if (!(await page.evaluate(() => document.documentElement.scrollWidth <= 420))) throw new Error('horizontal page overflow');
    await page.screenshot({ path: '.playwright-cli/updates-available-420.png' });
    const download = section.getByRole('button', { name: '下载 Windows 安装包', exact: false });
    await download.click();
    await section.getByText('已在浏览器打开下载。下载完成后，请按上方步骤安装。', { exact: true }).waitFor();
    const downloadUrl = await page.evaluate(() => window.openedUpdateUrls[0]);
    if (downloadUrl !== 'https://github.com/a985987819/MoChi/releases/download/v0.10.0/Mochi_0.10.0_x64-setup.exe') throw new Error('wrong installer IPC URL: ' + downloadUrl);

    // 发布页与安装包使用不同回执，不能把访问发布列表误报为开始下载。
    await section.getByRole('button', { name: '查看所有发布版本', exact: true }).click();
    await section.getByText('已在浏览器打开发布页，请选择适合本机的安装包。', { exact: true }).waitFor();
    if (await section.getByText('已在浏览器打开下载。下载完成后，请按上方步骤安装。', { exact: true }).count()) throw new Error('stale download feedback');

    await page.evaluate(() => { window.rejectUpdateOpener = true; });
    await download.click();
    const address = section.getByRole('textbox', { name: '更新下载地址', exact: true });
    await address.waitFor();
    await address.focus();
    const selected = await address.evaluate(element => ({ value: element.value, start: element.selectionStart, end: element.selectionEnd }));
    if (selected.value !== downloadUrl || selected.start !== 0 || selected.end !== downloadUrl.length) throw new Error('fallback URL is not fully selectable');
    await page.screenshot({ path: '.playwright-cli/updates-copy-fallback-420.png' });

    await page.evaluate(() => { window.updateScenario = 'unpublished'; window.rejectUpdateOpener = false; });
    await section.getByRole('button', { name: '检查更新', exact: true }).click();
    await section.getByText('暂时没有公开的正式版本，发布后可在这里检查。', { exact: true }).waitFor();
    if (await section.getByRole('button', { name: '下载 Windows 安装包', exact: false }).count()) throw new Error('stale installer after 404');

    await page.evaluate(() => { window.updateScenario = 'ahead'; });
    await section.getByRole('button', { name: '检查更新', exact: true }).click();
    await section.getByText('当前版本无需更新，公开正式版为 v0.8.2。', { exact: true }).waitFor();
    if (await section.getByRole('button', { name: '下载 Windows 安装包', exact: false }).count()) throw new Error('offered downgrade');

    await page.evaluate(() => { window.updateScenario = 'offline'; });
    await section.getByRole('button', { name: '检查更新', exact: true }).click();
    await section.getByText('暂时连不上更新服务，请检查网络后重试。', { exact: true }).waitFor();
    await page.evaluate(() => { window.updateScenario = 'missing'; });
    await section.getByRole('button', { name: '重新检查', exact: true }).click();
    await section.getByRole('button', { name: '前往发布页查看下载', exact: true }).waitFor();
    await section.getByRole('button', { name: '前往发布页查看下载', exact: true }).click();
    if ((await page.evaluate(() => window.openedUpdateUrls.at(-1))) !== 'https://github.com/a985987819/MoChi/releases/tag/v0.10.0') throw new Error('missing installer fallback is not release page');

    await page.evaluate(() => { window.updateScenario = 'pending'; });
    await section.getByRole('button', { name: '检查更新', exact: true }).click();
    await section.getByRole('button', { name: '检查中…', exact: true }).waitFor();
    if (!(await section.getByRole('button', { name: '检查中…', exact: true }).isDisabled())) throw new Error('duplicate checks enabled');
    await page.getByRole('button', { name: '聊天', exact: true }).click();
    await page.waitForFunction(() => window.updateAborts === 1);
    await page.evaluate(() => { window.updateScenario = 'available'; });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await section.getByRole('button', { name: '检查更新', exact: true }).waitFor();
    if (await section.getByText('正在检查公开发布的正式版本…', { exact: true }).count()) throw new Error('stale cancelled request state');
    await section.getByRole('button', { name: '检查更新', exact: true }).click();
    await section.getByText('发现新版本 v0.10.0', { exact: true }).waitFor();
    if (errors.length) throw new Error('browser errors: ' + errors.join('; '));
    return 'PASS: actual SettingsTab at 420x560, no background check, notes/plain text/keyboard, installer IPC, release-page feedback, selectable failed-opener URL, 404, local-ahead/no downgrade, offline retry, missing-installer fallback, disabled pending button, cancellation and re-entry; no page errors; no real download';
  } finally {
    page.off('pageerror', onError);
  }
}
