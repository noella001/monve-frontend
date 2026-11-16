import type { CartItem, Product, Order } from '../types';
import { apiRequest } from './http';
export type Customer = { id: string; name: string; email: string };
export type SavedShopping = { cart: CartItem[]; wishlist: Product[]; shopping_version: number; issues: string[] };
export type Account = SavedShopping & { customer: Customer; orders: Order[] };
export type AuthenticationResult = Account | { role: 'admin'; authenticated: true };
export type SignupStart = { message: string; verification_required: true; expires_in: number };
export type GoogleChallenge = { client_id: string; nonce: string; expires_in: number };
export async function accountRequest<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  return apiRequest<T>(`/api/account/${path}`, {
    method: body === undefined ? 'GET' : method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const startSignup = (input: { name: string; email: string; password: string }) =>
  accountRequest<SignupStart>('signup', input);

export const verifySignup = (email: string, code: string) =>
  accountRequest<Account>('signup/verify', { email, code });

export const getGoogleChallenge = () =>
  accountRequest<GoogleChallenge>('google/challenge', {});

export const signInWithGoogle = (credential: string) =>
  accountRequest<Account>('google', { credential });
