import { Product, Order, CustomClothingRequest, FlutterwaveConfig, OrderStatus, PaymentStatus, CustomRequestStatus } from '../types';
import { apiRequest, isBackendConfigured } from './http';
import { post } from './checkout';

type EventCallback = (data: any) => void;
const eventListeners = new Map<string, Set<EventCallback>>();
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let cursor = 0;
let polling = false;
let disconnected = false;
const versions = new Map<string, number>();
async function pollEvents() {
  if (polling || !eventListeners.size || !isBackendConfigured) return;
  polling = true;
  try {
    const payload = await apiRequest<{events:{type:string;data:any;version:number}[];cursor:number}>('/api/events?after=' + cursor);
    for (const event of payload.events) {
      const identity = event.type.split('_')[0] + ':' + event.data.id;
      if ((versions.get(identity) || 0) > event.version) continue;
      versions.set(identity, event.version);
      triggerStoreEvent(event.type, event.data);
    }
    cursor = payload.cursor;
    if (disconnected) triggerStoreEvent('store_reconnected', {});
    disconnected = false;
  } catch { disconnected = true; }
  finally { polling = false; if (eventListeners.size) pollTimer = setTimeout(pollEvents, 5000); }
}

export function triggerStoreEvent(event: string, data: unknown) {
  eventListeners.get(event)?.forEach(callback => callback(data));
}

export function subscribeToStoreEvents(event: string, callback: EventCallback) {
  if (!eventListeners.has(event)) eventListeners.set(event, new Set());
  eventListeners.get(event)!.add(callback);
  if (isBackendConfigured && !pollTimer && !polling) pollTimer = setTimeout(pollEvents, 5000);
  return () => {
    const callbacks = eventListeners.get(event);
    callbacks?.delete(callback);
    if (!callbacks?.size) eventListeners.delete(event);
    if (!eventListeners.size) { clearTimeout(pollTimer); pollTimer = undefined; }
  };
}

const jsonBody = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

function orderedProductImages<T extends Partial<Product>>(product: T): T {
  if (!('image_url' in product) && !('image_urls' in product)) return product;
  const image_urls = Array.from(new Set([product.image_url, ...(product.image_urls || [])]
    .map(url => url?.trim())
    .filter((url): url is string => Boolean(url)))).slice(0, 7);
  return { ...product, image_url: image_urls[0] || '', image_urls } as T;
}

// These functions are the integration boundary for the replacement service.
// Reads of private data and all writes require a configured service. They never
// fabricate successful orders or restore data from the removed backend's cache.
export async function getProducts(): Promise<Product[]> {
  const products = await apiRequest<Product[]>('/api/products');
  return products.map(product => orderedProductImages(product));
}

export async function createProduct(data: Partial<Product>): Promise<Product> {
  const { id, created_at, version, ...input } = data;
  const created = await apiRequest<Product>('/api/products', jsonBody('POST', orderedProductImages(input)));
  triggerStoreEvent('product_created', created);
  return created;
}

export async function updateProduct(id: string, updates: Partial<Product>): Promise<Product> {
  const { id: ignored, created_at, version, ...input } = updates;
  delete (input as any).updated_at;
  const current = version === undefined ? await apiRequest<Product>(`/api/products/${encodeURIComponent(id)}`) : null;
  const updated = await apiRequest<Product>(`/api/products/${encodeURIComponent(id)}`, jsonBody('PUT', { ...orderedProductImages(input), expected_version: version ?? current?.version }));
  triggerStoreEvent('product_updated', updated);
  return updated;
}

export async function deleteProduct(id: string): Promise<boolean> {
  await apiRequest(`/api/products/${encodeURIComponent(id)}`, { method: 'DELETE' });
  triggerStoreEvent('product_deleted', { id });
  return true;
}

export function getOrders(): Promise<Order[]> {
  return apiRequest('/api/orders');
}

export async function createOrder(data: Record<string, unknown>, key?: string): Promise<Order> {
  const created = await post<Order>('/api/orders',data,key);
  triggerStoreEvent('order_created',created);
  return created;
}

export async function updateOrderStatus(id: string, status: OrderStatus, paymentStatus?: PaymentStatus, note?: string): Promise<Order> {
  if (paymentStatus) throw new Error('Payment status is controlled by the provider. Use refund or reconciliation actions.');
  const current = await apiRequest<Order>(`/api/orders/${encodeURIComponent(id)}`);
  const updated = await apiRequest<Order>(`/api/orders/${encodeURIComponent(id)}/status`, jsonBody('PATCH', { status, note, expected_version: current.version }));
  triggerStoreEvent('order_updated', updated);
  return updated;
}

export function getCustomRequests(): Promise<CustomClothingRequest[]> {
  return apiRequest('/api/custom-requests');
}

export async function createCustomRequest(data: Record<string, unknown>, key: string): Promise<CustomClothingRequest> {
  const created = await post<CustomClothingRequest>('/api/custom-requests', data, key);
  triggerStoreEvent('custom_request_created', created);
  return created;
}

export async function updateCustomRequestStatus(id: string, status: CustomRequestStatus, notes?: string): Promise<CustomClothingRequest> {
  const current = (await getCustomRequests()).find(r => r.id === id);
  const updated = await apiRequest<CustomClothingRequest>(`/api/custom-requests/${encodeURIComponent(id)}/status`, jsonBody('PATCH', { status, notes, expected_version: current?.version }));
  triggerStoreEvent('custom_request_updated', updated);
  return updated;
}

export function getFlutterwaveConfig(): Promise<FlutterwaveConfig> {
  return apiRequest('/api/flutterwave/config');
}

export async function updateFlutterwaveConfig(config: Partial<FlutterwaveConfig>): Promise<void> {
  await apiRequest('/api/flutterwave/config', jsonBody('POST', { merchant_name: config.merchant_name }));
}

export async function adjustInventory(id: string, delta: number): Promise<Product> {
  const updated = await post<Product>(`/api/admin/inventory/${encodeURIComponent(id)}/adjustments`, {delta,reason:'Admin inventory adjustment'}, crypto.randomUUID());
  triggerStoreEvent('product_updated', updated);
  return updated;
}

export function upsert<T extends {id:string;version?:number}>(items:T[], item:T):T[] {
  const old=items.find(x=>x.id===item.id);
  if(old && (old.version || 0)>(item.version || 0))return items;
  return old ? items.map(x=>x.id===item.id?item:x) : [item,...items];
}
