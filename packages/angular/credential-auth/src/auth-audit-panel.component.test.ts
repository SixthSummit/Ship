import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { SHIP_AUTH_AUDIT_CLIENT, ShipAuthAuditPanelComponent } from './auth-audit-panel.component';
import type { ShipCredentialAuthCallResult } from './credential-auth-contract';

describe('ShipAuthAuditPanelComponent', () => {
  it('lists audit events, loads the account for an email and unlocks it; a refusal renders inline', async () => {
    let locked = true;
    const call = vi.fn(
      async (operation: string, input: unknown): Promise<ShipCredentialAuthCallResult> => {
        switch (operation) {
          case 'console.auth-audit.events':
            return {
              ok: true,
              status: 200,
              data: {
                events: [
                  {
                    id: 'e1',
                    event: 'sign-in',
                    outcome: 'failure',
                    accountId: 'acc-1',
                    requestId: 'r',
                    ip: '203.0.113.7',
                    details: { reason: 'wrong-password', attempts: 1 },
                    createdAt: '2026-10-23T12:00:00.000Z',
                  },
                ],
              },
            };
          case 'console.auth-audit.account':
            return {
              ok: true,
              status: 200,
              data: {
                account: {
                  id: 'acc-1',
                  email: 'ada@example.test',
                  roles: ['sre'],
                  mfaEnabled: true,
                  status: 'active',
                },
                locked,
                failedAttempts: locked ? 5 : 0,
                sessions: [{}],
                recoveryCodes: { remaining: 9, used: 1 },
              },
            };
          case 'console.auth-audit.unlock':
            locked = false;
            expect(input).toEqual({ body: { accountId: 'acc-1' } });
            return { ok: true, status: 200, data: { unlocked: true } };
          default:
            return {
              ok: false,
              status: 403,
              error: { code: 'AUTHORIZATION_ERROR', message: 'no' },
            };
        }
      }
    );
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: SHIP_AUTH_AUDIT_CLIENT, useValue: { call } },
      ],
    });
    const fixture = TestBed.createComponent(ShipAuthAuditPanelComponent);
    await fixture.whenStable();
    await fixture.componentInstance.reload();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('tbody')?.textContent).toContain('wrong-password');
    expect(element.querySelector('tbody')?.textContent).toContain('203.0.113.7');

    fixture.componentInstance.email.set('ada@example.test');
    await fixture.componentInstance.reload();
    await fixture.whenStable();
    expect(element.querySelector('.ship-console__account')?.textContent).toContain('locked');
    await fixture.componentInstance.unlock();
    await fixture.whenStable();
    expect(element.querySelector('.ship-console__account')?.textContent).not.toContain('locked');

    await fixture.componentInstance.revokeAll();
    await fixture.whenStable();
    expect(element.querySelector('[role=alert]')?.textContent).toContain('AUTHORIZATION_ERROR');
  });
});
