/** Every user-facing string lives here so wording can be reviewed and localized in one place. */

const INTRO = 'Namaste! Shuru karne se pehle 6 chhote sawaal. ';
const TAIL = [
  { key: 'tone', ask: '4) Captions ka tone kaisa ho? (jaise: pyaar bhara, mazedaar, seedha, professional)' },
  { key: 'banned', ask: '5) Kya kabhi nahi likhna ya post karna? (jaise "guaranteed", bachchon ke naam, ghar ka pata). Nahi hai to "kuch nahi" likhein.' },
  { key: 'language', ask: '6) Captions kis bhasha mein? (Hinglish, Hindi, English)' },
];

/** Onboarding follows the person's own goals: memories for a person, audience for a creator, customers for a business. */
export const ONBOARDING_BY_KIND: Record<string, Array<{ key: string; ask: string }>> = {
  personal: [
    { key: 'about', ask: INTRO + '1) Aap kya share karna chahte hain? (yaadein, family, travel, hobbies)' },
    { key: 'audience', ask: '2) Aapki posts kaun dekhega? (family, dost, sab log)' },
    { key: 'goal', ask: '3) Aapke liye sabse zaroori kya hai? (yaadein sambhalna, dosto se jude rehna, apni pehchaan dikhana)' },
    ...TAIL,
  ],
  creator: [
    { key: 'niche', ask: INTRO + '1) Aap kis cheez par content banate hain? (jaise food, comedy, fitness, padhai)' },
    { key: 'audience', ask: '2) Aapke followers kaun hain, ya kaun hone chahiye?' },
    { key: 'goal', ask: '3) Abhi sabse bada goal kya hai? (followers badhana, regular posting, brand deals)' },
    ...TAIL,
  ],
  business: [
    { key: 'business', ask: INTRO + '1) Aapka kaam/business kya hai?' },
    { key: 'offer', ask: '2) Aap kya bechte hain? (products ya services)' },
    { key: 'audience', ask: '3) Aapke customers kaun hain? (age, shehar, kya dhoondte hain)' },
    ...TAIL,
  ],
};
export const onboardingQuestions = (kind: string) => ONBOARDING_BY_KIND[kind] ?? ONBOARDING_BY_KIND.business!;

export const copy = {
  unknownSender: 'Ye number kisi workspace se juda nahi hai. Apne account owner se access maangein.',
  paused: 'Ye workspace abhi paused hai. Owner "resume" likh kar chalu kar sakta hai.',
  onboardingDone: 'Shukriya! Profile save ho gaya. Ab koi video ya photo bhejiye, main caption bana kar approval ke liye bhejunga. Account jodne ke liye "connect" likhein.',
  greet: 'Namaste! 🙏 Photo ya video bhejiye, saath mein 1 line likhiye ki ye kis baare mein hai. Main caption bana kar approval ke liye bhejunga. Aur options ke liye "help" likhein.',
  help: 'Main ye kar sakta hoon:\n• Video/photo bhejein → caption + approval → post\n• "report" → last posts ke numbers\n• "connect" → Instagram/Facebook jodna\n• "status", "pause", "resume"\n• "forget" → meri yaad hataana, "export", "delete" → aapka data',
  demoMode: 'Main abhi demo mode mein hoon (AI band hai), isliye sirf commands samajhta hoon: help, report, status, connect, ya photo/video bhejein. Baat-cheet ke liye AI key jodni hogi.',
  notUnderstood: 'Samajh nahi aaya. "help" likhein, ya video/photo bhejein.',
  aiLimited: 'Abhi main sirf simple commands samajh sakta hoon: help, report, status, connect. (AI limit)',
  viewerOnly: 'Aapke paas sirf dekhne ka access hai. Owner ya editor se kahein.',
  noUpload: 'Aapke paas upload ka access nahi hai.',
  ownerOnly: 'Ye sirf owner kar sakta hai.',
  newPost: 'Theek hai. Video ya photo yahin bhejein, saath mein 1 line likh dein ki ye kis baare mein hai.',
  mediaReceived: 'Mil gaya. Check kar raha hoon...',
  askTopic: 'Ye kis baare mein hai? 1 line mein batayein (offer, price ya date ho to woh bhi).',
  askCaption: 'Caption khud likh kar bhej dein. Wahi approval ke liye aayega.',
  aiCaptionUnavailable: 'Abhi caption auto nahi ban paya. Aap caption khud likh kar bhej dein. Kuch post nahi hua.',
  reshoot: (problems: string[]) => `Is file mein dikkat hai: ${problems.join(', ')}. Kripya dobara record karke bhejein. Kuch post nahi hua.`,
  consentQuestion: 'Post se pehle ek sawaal: is video/photo mein aapke alawa koi aur insaan dikh raha hai?',
  consentButtons: (taskId: string) => [
    { id: `c:${taskId}:n`, title: 'Nahi, sirf main' },
    { id: `c:${taskId}:y`, title: 'Haan, permission hai' },
    { id: `c:${taskId}:m`, title: 'Bachche/pata nahi' },
  ],
  consentBlocked: 'Is content mein bachche ho sakte hain ya permission pakki nahi hai, isliye main ise public nahi karunga. Kuch post nahi hua.',
  consentAlready: 'Ye jawab pehle hi note hai.',
  approvalCard: (caption: string, platform: string, claims: string[], publicNote: boolean) =>
    `Ye post publish karni hai?\n\n${caption}\n\nPlatform: ${platform}${publicNote ? '\nAudience: PUBLIC' : ''}${claims.length ? `\n\n⚠ Check karein: ${claims.join(' | ')}` : ''}`,
  approvalButtons: (approvalId: string) => [
    { id: `a:${approvalId}:y`, title: 'Approve' },
    { id: `a:${approvalId}:e`, title: 'Caption badlo' },
    { id: `a:${approvalId}:n`, title: 'Reject' },
  ],
  approved: 'Approved. Publish kar raha hoon, live link verify karke bhejunga.',
  rejected: 'Theek hai, cancel kar diya. Kuch publish nahi hua.',
  expired: 'Ye approval expire ho gaya. Kuch publish nahi hua. Dobara bhejein to naya card aayega.',
  alreadyHandled: 'Ye request pehle hi process ho chuki hai.',
  notYourWorkspace: 'Ye request aapke workspace ki nahi hai.',
  approvalOwnerOnly: 'Approval sirf owner de sakta hai.',
  live: (url: string | null) => `Live ho gaya ✅${url ? `\n${url}` : ''}`,
  publishFailed: (reason: string) => `Platform ne post accept nahi ki (${reason}). Kuch publish nahi hua. Caption ya file badal kar dobara bhejein.`,
  stuck: 'Ek post atak gayi. Pakka nahi pata ki gayi ya nahi, isliye dobara try nahi kiya. Hum check kar rahe hain.',
  blockedRoute: (why: string) => `${why} Kuch publish nahi hua.`,
  noAccount: 'Abhi koi Instagram/Facebook account juda nahi hai. "connect" likh kar jodein.',
  notConnected: 'Is account par publishing abhi connected/verified nahi hai.',
  unsupported: 'Is account type par main post nahi kar sakta.',
  assisted: (platform: string, caption: string) =>
    `${platform} par API se auto-post nahi hota, isliye aap khud post karenge. Caption ready hai:\n\n${caption}\n\nSteps: 1) bheji hui file use karein 2) caption paste karein 3) audience app mein chunein 4) post karke "Post kar diya" dabayein.`,
  assistedButtons: (taskId: string) => [
    { id: `u:${taskId}:d`, title: 'Post kar diya' },
    { id: `u:${taskId}:c`, title: 'Cancel' },
  ],
  assistedDone: 'Note kar liya. Ye aapki confirmation par hai, maine platform par verify nahi kiya.',
  cancelled: 'Cancel kar diya. Kuch publish nahi hua.',
  nothingToCancel: 'Abhi koi kaam pending nahi hai.',
  reportEmpty: 'Abhi tak koi post live nahi hui. Video ya photo bhejiye.',
  reportHeader: 'Last posts:',
  reportFooter: '(Sirf woh numbers jo platform ne diye.)',
  reportLine: (caption: string, m: Record<string, number | null>) =>
    `• ${caption.split('\n')[0]?.slice(0, 40)} - ${fmt(m.views, 'views')}, ${fmt(m.likes, 'likes')}, ${fmt(m.comments, 'comments')}`,
  status: (s: { active: boolean; accounts: number; pending: number; posts7d: number }) =>
    `Status: ${s.active ? 'chalu' : 'paused'}. Jude accounts: ${s.accounts}. Pending kaam: ${s.pending}. Pichhle 7 din mein posts: ${s.posts7d}.`,
  pausedOk: 'Workspace pause kar diya. Koi post nahi jayegi. "resume" likh kar chalu karein.',
  resumedOk: 'Workspace phir se chalu hai.',
  connectLink: (url: string) => `Instagram/Facebook jodne ke liye ye link kholein (1 ghante tak chalega): ${url}\nPassword yahan chat mein kabhi na bhejein.`,
  connected: (label: string, route: string) => `${label} jud gaya. ${route === 'E' ? 'Approval ke baad main khud post karke verify karunga.' : route === 'A' ? 'Is account par aap khud post karenge, main content ready karunga.' : 'Is account type par posting supported nahi hai.'}`,
  reconnect: (label: string, url: string) => `${label} ka connection expire ho gaya. Is link se dobara jodein: ${url}\nTab tak is account ki posts ruki hain.`,
  forgetAsk: 'Main aapke baare mein jo yaad rakhta hoon (business, tone, facts) sab hata doon? Profile ke jawab bhi hatenge.',
  forgetButtons: [{ id: 'f:y', title: 'Haan, hata do' }, { id: 'f:n', title: 'Nahi' }],
  forgotten: 'Sab hata diya. Naye sire se shuru karne ke liye "start" likhein.',
  exportReady: (url: string) => `Aapka data export tayyar hai. Link 24 ghante aur 1 baar chalega: ${url}`,
  deleteAsk: (days: number) => `Poora workspace data hamesha ke liye hat jayega (${days} din baad). Confirm karne ke liye DELETE likhein.`,
  deleteScheduled: (days: number) => `Theek hai. ${days} din baad sab hat jayega. Rokne ke liye "cancel delete" likhein.`,
  deleteCancelled: 'Delete roka gaya. Aapka data safe hai.',
  deleteNotConfirmed: 'Delete confirm nahi hua. Data safe hai.',
  deleted: 'Aapka data hata diya gaya. Sirf bina-naam ka audit record bacha hai.',
  secretWarning: 'Kripya password, OTP ya card number chat mein na bhejein. Maine ise save nahi kiya.',
  digest: (s: { posts: number; prev: number; lines: string[] }) =>
    `Is hafte ka summary:\n• Posts: ${s.posts}${s.prev > 0 ? ` (pichhle hafte ${s.prev})` : ''}${s.lines.length ? '\n' + s.lines.join('\n') : ''}\n(Sirf platform ke numbers.)`,
  thinData: 'Abhi data kam hai, isliye trend nahi bata sakta.',
};

function fmt(v: number | null | undefined, label: string): string {
  return v === null || v === undefined ? `${label}: data nahi mila` : `${v} ${label}`;
}
