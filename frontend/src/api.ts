import { systemMessage, t } from './i18n'
export interface ServerArchive {
  id: string
  name: string
  description: string
  startDate: string
  endDate: string | null
  status: 'RECORDING' | 'ARCHIVED'
  createdAt: string
  updatedAt: string
}

let csrf: { headerName: string; token: string } | undefined
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function refreshCsrf() {
  const response = await fetch('/api/auth/csrf', { credentials: 'same-origin' })
  if (!response.ok) throw new ApiError(response.status, t('m0001'))
  csrf = await response.json()
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = options.method ?? 'GET'
  const headers = new Headers(options.headers)
  if (!['GET', 'HEAD'].includes(method)) {
    if (!csrf) await refreshCsrf()
    headers.set(csrf!.headerName, csrf!.token)
  }
  if (options.body && !(options.body instanceof URLSearchParams))
    headers.set('Content-Type', 'application/json')
  const response = await fetch(`/api${path}`, { ...options, headers, credentials: 'same-origin' })
  if (!response.ok) {
    let message = response.status === 401 ? t('m0002') : t('m0003')
    if (response.status === 403) {
      csrf = undefined
      message = t('m0004')
    }
    try {
      const body = await response.json()
      message = body.message ? systemMessage(body.message) : message
    } catch {
      /* No JSON for security errors. */
    }
    throw new ApiError(response.status, message)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export async function uploadBackup(
  id: string,
  file: File,
  progress: (fraction: number) => void,
): Promise<void> {
  if (!csrf) await refreshCsrf()
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('PUT', `/api/backups/${id}/content`)
    request.setRequestHeader(csrf!.headerName, csrf!.token)
    request.setRequestHeader('Content-Type', 'application/octet-stream')
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(event.loaded / event.total)
    }
    request.onerror = () => reject(new ApiError(0, t('m0005')))
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve()
      else {
        let message = request.status === 401 ? t('m0002') : t('m0006')
        if (request.status === 403) {
          csrf = undefined
          message = t('m0007')
        }
        try {
          message = systemMessage(JSON.parse(request.responseText).message ?? message)
        } catch {
          /* proxy/security error */
        }
        reject(new ApiError(request.status, message))
      }
    }
    request.send(file)
  })
}
