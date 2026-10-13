export interface ReportNotification {
  readonly tenantId: string;
  readonly recipient: string;
  readonly subject: string;
  readonly requestedBy: string;
}

export interface ReportNotifier {
  readonly adapter: string;
  send(notification: ReportNotification): Promise<void>;
}

/** Where dispatched payment webhook events are recorded after durable receipt. */
export interface PaymentEventSink {
  readonly adapter: string;
  record(event: { readonly eventId: string; readonly provider: string }): Promise<void>;
}
