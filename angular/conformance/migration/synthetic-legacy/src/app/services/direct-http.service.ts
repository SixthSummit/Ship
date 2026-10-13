import { HttpClient } from '@angular/common/http';

export class DirectHttpService {
  constructor(private http: HttpClient) {}

  read(token: string) {
    return this.http.get('/fixture/status', {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
}
