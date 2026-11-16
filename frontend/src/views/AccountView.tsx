import { useCallback, useEffect, useRef, useState } from 'react';
import { accountRequest, getGoogleChallenge, signInWithGoogle, startSignup, verifySignup, type Account, type AuthenticationResult, type Customer } from '../services/account';
import type { Order } from '../types';
import { ApiError, isBackendConfigured } from '../services/http';

type Props = {
  mode: string; customer: Customer | null; orders: Order[]; loading: boolean;
  cartCount: number; wishlistCount: number; error: string;
  onAuthenticated: (account: Account) => void | Promise<void>; onAdminAuthenticated: () => void;
  onNavigate: (view: string) => void;
  onResumeOrder: (order:Order) => void; onRecoverShopping: () => Promise<void>;
  onCart: () => void; onWishlist: () => void; onLogout: () => Promise<void>;
};

type GoogleCredentialResponse = { credential?: string };
type GoogleIdentity = {
  initialize: (options: { client_id: string; nonce: string; callback: (response: GoogleCredentialResponse) => void }) => void;
  renderButton: (element: HTMLElement, options: { theme: string; size: string; shape: string; text: string; width: number }) => void;
};
declare global {
  interface Window {
    google?: { accounts: { id: GoogleIdentity } };
  }
}

let googleScriptPromise: Promise<void> | null = null;
function loadGoogleIdentity(): Promise<void> {
  if (window.google?.accounts.id) return Promise.resolve();
  if (googleScriptPromise) return googleScriptPromise;
  googleScriptPromise = new Promise((resolve, reject) => {
    let script = document.querySelector<HTMLScriptElement>('script[data-google-identity]');
    if (script?.dataset.failed === 'true') {
      script.remove();
      script = null;
    }
    if (!script) {
      script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.dataset.googleIdentity = 'true';
    }
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      script.removeEventListener('load', ready);
      script.removeEventListener('error', fail);
      if (error) { googleScriptPromise = null; reject(error); }
      else resolve();
    };
    const fail = () => {
      script!.dataset.failed = 'true';
      finish(new Error('Google sign-in could not load. Please check your connection and try again.'));
    };
    const ready = () => {
      script!.dataset.loaded = 'true';
      if (window.google?.accounts.id) finish();
      else window.setTimeout(() => window.google?.accounts.id ? finish() : fail(), 100);
    };
    const timeout = window.setTimeout(fail, 12000);
    script.addEventListener('load', ready, { once: true });
    script.addEventListener('error', fail, { once: true });
    if (!script.isConnected) document.head.appendChild(script);
    else if (script.dataset.loaded === 'true') {
      window.setTimeout(() => {
        if (window.google?.accounts.id) finish();
        else fail();
      }, 100);
    }
  });
  return googleScriptPromise;
}

export function AccountView(props: Props) {
  const { customer, orders, mode, onNavigate } = props;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('orders');
  const [verificationPending, setVerificationPending] = useState(false);
  const [verificationCode, setVerificationCode] = useState('');
  const [pendingSignup, setPendingSignup] = useState<{ name: string; email: string; password: string } | null>(null);
  const [verificationMessage, setVerificationMessage] = useState('');
  const [codeExpiresIn, setCodeExpiresIn] = useState(0);
  const [resendIn, setResendIn] = useState(0);
  const [googleError, setGoogleError] = useState('');
  const [googleReady, setGoogleReady] = useState(false);
  const [googlePreparing, setGooglePreparing] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const googleButton = useRef<HTMLDivElement>(null);
  const onAuthenticatedRef = useRef(props.onAuthenticated);
  onAuthenticatedRef.current = props.onAuthenticated;
  const signup = mode === 'signup';

  const prepareGoogleButton = useCallback(async (retryMessage = '') => {
    if (!googleButton.current || !isBackendConfigured) return;
    setGooglePreparing(true);
    setGoogleReady(false);
    setGoogleError(retryMessage);
    try {
      const [challenge] = await Promise.all([getGoogleChallenge(), loadGoogleIdentity()]);
      if (!googleButton.current) return;
      const element = googleButton.current;
      element.replaceChildren();
      window.google!.accounts.id.initialize({
        client_id: challenge.client_id,
        nonce: challenge.nonce,
        callback: async response => {
          if (!response.credential) {
            const message = 'Google did not return a sign-in credential.';
            setGoogleError(message);
            void prepareGoogleButton(`${message} A fresh challenge is ready; try again.`);
            return;
          }
          setGoogleLoading(true); setGoogleError('');
          try {
            const account = await signInWithGoogle(response.credential);
            await onAuthenticatedRef.current(account);
          } catch (e) {
            const message = (e as Error).message;
            setGoogleError(`${message} Getting a fresh sign-in challenge…`);
            void prepareGoogleButton(`${message} A fresh challenge is ready; try again.`);
          } finally { setGoogleLoading(false); }
        },
      });
      window.google!.accounts.id.renderButton(element, { theme: 'outline', size: 'large', shape: 'rectangular', text: 'continue_with', width: Math.max(240, Math.floor(element.clientWidth || 320)) });
      setGoogleReady(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'GOOGLE_LOGIN_NOT_CONFIGURED') {
        setGoogleError('Google sign-in is not configured on the server yet.');
      } else setGoogleError((e as Error).message);
    } finally { setGooglePreparing(false); }
  }, []);

  useEffect(() => {
    if (!customer && !verificationPending) void prepareGoogleButton();
  }, [customer, mode, verificationPending, prepareGoogleButton]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn(value => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  useEffect(() => {
    if (!verificationPending || codeExpiresIn <= 0) return;
    const timer = window.setTimeout(() => setCodeExpiresIn(value => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [verificationPending, codeExpiresIn]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true); setError('');
    try {
      if (signup) {
        const details = Object.fromEntries(form) as { name: string; email: string; password: string };
        const result = await startSignup(details);
        setPendingSignup(details);
        setVerificationCode('');
        setVerificationPending(result.verification_required === true);
        setVerificationMessage(result.message);
        setResendIn(60);
        setCodeExpiresIn(result.expires_in);
      } else {
        const result = await accountRequest<AuthenticationResult>('login', Object.fromEntries(form));
        if ('customer' in result) await props.onAuthenticated(result);
        else props.onAdminAuthenticated();
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function verify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingSignup) return;
    setBusy(true); setError('');
    try {
      const account = await verifySignup(pendingSignup.email, verificationCode.trim());
      await props.onAuthenticated(account);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function resendCode() {
    if (!pendingSignup || resendIn > 0 || busy) return;
    setBusy(true); setError('');
    try {
      const result = await startSignup(pendingSignup);
      setVerificationMessage(result.message);
      setResendIn(60);
      setCodeExpiresIn(result.expires_in);
      setVerificationCode('');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  if (!isBackendConfigured) return (
    <section className="account-page account-auth">
      <div><p className="account-kicker">YOUR MONVÉ</p><h1>Accounts are coming soon.</h1>
        <p>Sign-in and registration are not connected right now. Please check back soon to create an account and save your bag and favourites.</p>
        <button className="account-primary" onClick={() => onNavigate('shop')}>Continue shopping</button>
      </div>
    </section>
  );
  if (props.loading) return <div className="account-page" role="status">Loading your account…</div>;
  if (!customer) return (
    <section className="account-page account-auth">
      <div><p className="account-kicker">YOUR MONVÉ</p><h1>{signup ? 'Make it yours.' : 'Welcome back.'}</h1>
        <p>Keep your favourites close. Find your orders, saved cart, and next favourite piece in one place.</p>
        <button className="account-link" onClick={() => onNavigate('shop')}>Continue shopping without an account →</button>
      </div>
      <form key={mode} onSubmit={verificationPending ? verify : submit} className="account-panel">
        <h2>{verificationPending ? 'Verify your email' : signup ? 'Create an account' : 'Log in'}</h2>
        {!verificationPending && !signup && <p className="account-muted">Administrators can use their existing credentials here to open the admin dashboard.</p>}
        {verificationPending ? (
          <>
            <p className="account-muted">{verificationMessage || `Enter the 6-digit code sent to ${pendingSignup?.email}.`}</p>
            {codeExpiresIn > 0
              ? <p className="account-muted">Code expires in {Math.floor(codeExpiresIn / 60)}:{String(codeExpiresIn % 60).padStart(2, '0')}.</p>
              : <p className="account-muted" role="status">This code may have expired. Request a new code to continue.</p>}
            <label>Verification code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required value={verificationCode} onChange={event => setVerificationCode(event.target.value.replace(/\D/g, '').slice(0, 6))} /></label>
            {error && <p role="alert">{error}</p>}
            <button className="account-primary" disabled={busy || verificationCode.length !== 6 || codeExpiresIn <= 0}>{busy ? 'Please wait…' : 'Verify email & create account'}</button>
            <button type="button" className="account-link" disabled={busy || resendIn > 0} onClick={() => void resendCode()}>
              {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend verification code'}
            </button>
            <button type="button" className="account-link" disabled={busy} onClick={() => { setVerificationPending(false); setVerificationCode(''); setError(''); setResendIn(0); }}>
              Change signup details
            </button>
          </>
        ) : (
          <>
            {signup && <label>Full name<input name="name" autoComplete="name" required maxLength={100} /></label>}
            <label>Email address<input name="email" type="email" autoComplete="email" required maxLength={254} defaultValue={pendingSignup?.email || ''} /></label>
            <label>Password<input name="password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} required minLength={signup ? 12 : undefined} maxLength={128} /></label>
            {signup && <p className="account-muted">Use at least 12 characters. Never reuse a password from another site.</p>}
            {(error || props.error) && <p role="alert">{error || props.error}</p>}
            <button className="account-primary" disabled={busy || googleLoading}>{busy ? 'Please wait…' : signup ? 'Continue with email' : 'Log in'}</button>
            <div className="my-5 flex items-center gap-3 text-xs account-muted"><span className="h-px flex-1 bg-[var(--tone-333333)]" /><span>OR</span><span className="h-px flex-1 bg-[var(--tone-333333)]" /></div>
            <p className="mb-3 text-center text-sm">Use Google instead</p>
            <div ref={googleButton} className="flex min-h-11 items-center justify-center" aria-label="Continue with Google">
              {!googleReady && !googleError && <span className="account-muted" role="status">{googlePreparing ? 'Preparing Google sign-in…' : 'Google sign-in is loading…'}</span>}
            </div>
            {googleLoading && <p className="account-muted" role="status">Signing in with Google…</p>}
            {googleError && <p role="alert">{googleError}</p>}
            {googleError && <button type="button" className="account-link" disabled={googlePreparing} onClick={() => void prepareGoogleButton()}>{googlePreparing ? 'Please wait…' : 'Try Google sign-in again'}</button>}
            <button type="button" className="account-link" onClick={() => { setError(''); setPendingSignup(null); onNavigate(signup ? 'login' : 'signup'); }}>
              {signup ? 'Already a member? Log in' : 'New to MONVÉ? Create an account'}
            </button>
          </>
        )}
      </form>
    </section>
  );
  return (
    <section className="account-page">
      <div className="account-heading"><div><p className="account-kicker">MY ACCOUNT</p><h1>Hello, {customer.name.split(' ')[0]}.</h1><p>Your pieces. Your favourites. Your next chapter.</p></div>
        <button className="account-link" disabled={busy} onClick={async () => { setBusy(true); try { await props.onLogout(); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }}>Log out</button>
      </div>
      {(error || props.error) && <p role="alert">{error || props.error}</p>}
      {props.error && <div><p className="account-muted">Recovery restores your unsaved bag over the current saved bag when a backup exists. Otherwise it merges saved guest items.</p><button className="account-link" disabled={busy} onClick={async()=>{setBusy(true);try{await props.onRecoverShopping();setError('');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>Recover saved shopping</button></div>}
      <div className="account-summary">
        <button onClick={() => setTab('orders')}><strong>{orders.length}</strong><span>My orders</span></button>
        <button onClick={props.onCart}><strong>{props.cartCount}</strong><span>Cart · continue checkout</span></button>
        <button onClick={props.onWishlist}><strong>{props.wishlistCount}</strong><span>Saved favourites</span></button>
      </div>
      <div className="account-tabs"><button aria-pressed={tab === 'orders'} onClick={() => setTab('orders')}>Order history</button><button aria-pressed={tab === 'profile'} onClick={() => setTab('profile')}>Profile</button></div>
      {tab === 'profile' ? <div className="account-panel"><h2>Your details</h2><p>{customer.name}</p><p>{customer.email}</p><p className="account-muted">Your delivery address is collected during checkout.</p></div> :
        <div className="account-panel"><h2>Your orders</h2><p className="account-muted">Items in your cart are not orders yet. Orders awaiting payment appear below separately from paid purchases.</p>
          {!orders.length ? <div className="account-empty"><h3>Your story starts here.</h3><p>You haven’t placed an order with this account yet.</p><button className="account-primary" onClick={() => onNavigate('shop')}>Explore the collection</button></div> : orders.map(order => (
            <details key={order.id} className="account-order"><summary><span>{order.order_number}<small>{new Date(order.created_at).toLocaleDateString()}</small></span><span>{order.payment_status === 'PENDING' ? 'Awaiting payment' : order.payment_status === 'FAILED' ? 'Payment failed' : order.status}<small>{order.total.toLocaleString()} RWF</small></span></summary>
              {order.items.map((item, i) => <p key={i}>{item.product_name} · {item.size} · {item.color} × {item.quantity}</p>)}
              <p>Delivery: {order.delivery_street}, {order.delivery_sector}, {order.delivery_district}</p>
              {order.timeline.map((event, i) => <p key={i}>{event.title} — {event.description}</p>)}
              {['PENDING','FAILED'].includes(order.payment_status) && order.status!=='CANCELLED' && <button className="account-link" onClick={()=>props.onResumeOrder(order)}>Resume payment / check status</button>}
            </details>
          ))}
        </div>}
    </section>
  );
}
