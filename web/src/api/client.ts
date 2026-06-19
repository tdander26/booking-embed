import type {
  PublicBranding,
  PublicEventType,
  AvailabilityResponse,
  BookingConfirmation,
  ManageView,
  EventType,
  AvailabilitySchedule,
  AdminBooking,
  GoogleStatus,
} from './types';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  path: string,
  opts: RequestInit & { admin?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
  if (opts.body) headers['Content-Type'] = 'application/json';
  if (opts.admin) {
    const token = await idToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`/api${path}`, { ...opts, headers });
  const text = await res.text();
  const data = text ? safeParse(text) : null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error ?? 'error',
      data?.message ?? `Request failed (${res.status})`,
    );
  }
  return data as T;
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function idToken(): Promise<string | null> {
  const { getFirebaseAuth } = await import('../lib/firebase');
  const user = getFirebaseAuth().currentUser;
  return user ? user.getIdToken() : null;
}

// ---- Public ----
export const getBranding = () => request<PublicBranding>('/branding');
export const getEventTypes = () =>
  request<{ eventTypes: PublicEventType[] }>('/event-types');
export const getEventType = (slug: string) =>
  request<PublicEventType>(`/event-types/${encodeURIComponent(slug)}`);

export const getAvailability = (params: {
  eventTypeId?: string;
  slug?: string;
  from: string;
  to: string;
  tz: string;
}) => {
  const q = new URLSearchParams();
  if (params.eventTypeId) q.set('eventTypeId', params.eventTypeId);
  if (params.slug) q.set('slug', params.slug);
  q.set('from', params.from);
  q.set('to', params.to);
  q.set('tz', params.tz);
  return request<AvailabilityResponse>(`/availability?${q.toString()}`);
};

export const createBooking = (body: {
  eventTypeId: string;
  startUtc: string;
  timezone: string;
  name: string;
  email: string;
  phone?: string;
  notes?: string;
  source?: 'web' | 'embed';
}) =>
  request<BookingConfirmation>('/bookings', {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const getManage = (id: string, token: string) =>
  request<ManageView>(`/bookings/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`);

export const cancelBooking = (id: string, token: string, reason?: string) =>
  request<ManageView>(`/bookings/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ token, reason }),
  });

// ---- Admin ----
export const adminGetEventTypes = () =>
  request<{ eventTypes: EventType[] }>('/admin/event-types', { admin: true });
export const adminCreateEventType = (body: Partial<EventType>) =>
  request<EventType>('/admin/event-types', {
    admin: true,
    method: 'POST',
    body: JSON.stringify(body),
  });
export const adminUpdateEventType = (id: string, body: Partial<EventType>) =>
  request<EventType>(`/admin/event-types/${id}`, {
    admin: true,
    method: 'PUT',
    body: JSON.stringify(body),
  });
export const adminDeleteEventType = (id: string) =>
  request<{ ok: true }>(`/admin/event-types/${id}`, { admin: true, method: 'DELETE' });

export const adminGetSchedules = () =>
  request<{ schedules: AvailabilitySchedule[] }>('/admin/schedules', { admin: true });
export const adminCreateSchedule = (body: Partial<AvailabilitySchedule>) =>
  request<AvailabilitySchedule>('/admin/schedules', {
    admin: true,
    method: 'POST',
    body: JSON.stringify(body),
  });
export const adminUpdateSchedule = (id: string, body: Partial<AvailabilitySchedule>) =>
  request<AvailabilitySchedule>(`/admin/schedules/${id}`, {
    admin: true,
    method: 'PUT',
    body: JSON.stringify(body),
  });
export const adminDeleteSchedule = (id: string) =>
  request<{ ok: true }>(`/admin/schedules/${id}`, { admin: true, method: 'DELETE' });

export const adminGetBookings = (from?: string, to?: string) => {
  const q = new URLSearchParams();
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  return request<{ bookings: AdminBooking[] }>(`/admin/bookings?${q.toString()}`, {
    admin: true,
  });
};

export const adminGetBranding = () =>
  request<PublicBranding & { updatedAt?: string }>('/admin/branding', { admin: true });
export const adminSaveBranding = (body: Partial<PublicBranding>) =>
  request<PublicBranding>('/admin/branding', {
    admin: true,
    method: 'PUT',
    body: JSON.stringify(body),
  });

export const adminGoogleStatus = () =>
  request<GoogleStatus>('/admin/google/status', { admin: true });
export const adminGoogleAuthUrl = () =>
  request<{ url: string }>('/admin/google/auth-url', { admin: true });
export const adminGoogleDisconnect = () =>
  request<{ ok: true }>('/admin/google/disconnect', { admin: true, method: 'POST' });
