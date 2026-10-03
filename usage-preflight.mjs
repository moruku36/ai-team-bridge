import {subscriptionPreflight,plan} from './wrapper.mjs';
const [flag,provider]=process.argv.slice(2);
try {
  if(flag!=='--provider'||process.argv.length!==4||!['claude','antigravity'].includes(provider))throw Error();
  const request={provider,model:provider==='claude'?'sonnet':'gemini-3.8-flash-medium',...(provider==='antigravity'?{taskScope:{mode:'plan',description:'Display official usage only.'}}:{})};
  // Reuse the existing subscription-only guard. It never starts login or emits
  // raw auth status, account identifiers, setting contents or credential values.
  await subscriptionPreflight(request,plan(request,process.cwd()));
  console.log(JSON.stringify({ready:true,provider,subscriptionOnly:true}));
}catch{console.log(JSON.stringify({ready:false,reason:'existing_subscription_unavailable'}));process.exitCode=2;}
