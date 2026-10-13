import { provideHttpClient, withFetch } from '@angular/common/http';

export const providers = [provideHttpClient(withFetch())];
