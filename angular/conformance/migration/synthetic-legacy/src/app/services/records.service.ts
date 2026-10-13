// Synthetic examples of four migration patterns, not application behavior.
import ApiClient from '../lib/core/api/client/ApiClient';

export class RecordsService {
  constructor(private api: ApiClient) {}

  read() {
    return this.api.get('/fixture/records');
  }
  update() {
    return this.api.patch('/fixture/records/1', { label: 'sample' });
  }
  upload(file: File) {
    const data = new FormData();
    data.append('file', file);
    return this.api.post('/fixture/import', data);
  }
  download() {
    return this.api.get('/fixture/export', { responseType: 'blob' });
  }
}
