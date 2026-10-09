async function verify() {
  const statusRes = await fetch('http://127.0.0.1:3000/api/status');
  const statusJson = await statusRes.json();
  const csrfToken = statusJson.csrfToken;
  console.log('1. Status CSRF Token acquired:', csrfToken ? 'YES' : 'NO');

  const keyRes = await fetch('http://127.0.0.1:3000/api/platform/config/api-key-status');
  console.log('1.2 API Key Status:', await keyRes.json());

  // 1. Parse targets
  const pRes = await fetch('http://127.0.0.1:3000/api/platform/targets/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Nonce': csrfToken },
    body: JSON.stringify({ rawText: 'PRRHC,MEXCBTデモ学校,FAh3jGRY\nPAKCW,まなホーダイデモ学校,FAh3jGRY' })
  });
  const pData = await pRes.json();
  console.log('2. Targets Parsed:', pData.targetSet?.summary);

  // 2. Generate Plan with Claude Haiku 5.5
  console.log('3. Sending prompt to Claude Haiku 5.5...');
  const gRes = await fetch('http://127.0.0.1:3000/api/platform/plan/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Nonce': csrfToken },
    body: JSON.stringify({
      targetSet: pData.targetSet,
      userInstruction: '児童生徒がパスワードを変更できる設定にしてください。あと、https://kids.yahoo.co.jp/を「ヤフーキッズ」としてブックマーク登録してください。'
    })
  });
  const gData = await gRes.json();
  console.log('4. Plan Response HTTP Status:', gRes.status);
  if (!gRes.ok) {
    console.error('Error response:', gData);
    return;
  }
  console.log('Plan ID:', gData.executionPlan?.planId);
  console.log('Plan Status:', gData.executionPlan?.status);
  console.log('Risk Level:', gData.executionPlan?.riskLevel);
  console.log('Human Summary:\n', JSON.stringify(gData.executionPlan?.humanSummary, null, 2));
  console.log('Operations count:', gData.executionPlan?.operations?.length);
  console.log('Operations:', gData.executionPlan?.operations?.map((o: any) => ({
    opType: o.operationType,
    capabilityId: o.capabilityId,
    risk: o.riskClass,
    input: o.inputMapping
  })));
  console.log('Validation Scope Proposal:', gData.executionPlan?.validationScopeProposal);
  console.log('Estimated Time:', gData.timeEstimate?.displayFormatted);
  console.log('Estimated Cost:', gData.costEstimate?.estimatedCostJpy, 'JPY');
}

verify().catch(console.error);
