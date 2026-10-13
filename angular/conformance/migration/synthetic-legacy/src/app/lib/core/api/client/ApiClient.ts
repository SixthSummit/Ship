// Intentionally lossy API wrapper used only as migration-analyzer input.
import { HttpClient } from '@angular/common/http';

export default class ApiClient {
  constructor(private http: HttpClient) {}

  async get<T>(url: string): Promise<T> {
    try {
      return await this.http.get<T>(url, { withCredentials: true }).toPromise();
    } catch (error) {
      throw new Error(error.message);
    }
  }
}
