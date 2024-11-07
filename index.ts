import express, { Request, Response } from 'express'
import fetch, { Response as FetchResponse, RequestInit } from 'node-fetch'
import iconv from 'iconv-lite'
import { URL } from 'url'

type AllowedDomain = 'salafitalk.net' | 'salafitalk.com' | 'sahihmuslim.com'

interface DomainConfig {
  prefix: string;
  domain: AllowedDomain;
  pathPrefix: string;  // The prefix used in the actual site URLs
}

// Domain configurations with their prefixes
const DOMAIN_CONFIGS: Record<string, DomainConfig> = {
  'st': { prefix: 'st', domain: 'salafitalk.net', pathPrefix: 'st' },
  'sm': { prefix: 'sm', domain: 'sahihmuslim.com', pathPrefix: 'sps/smm' },
  'sc': { prefix: 'sc', domain: 'salafitalk.com', pathPrefix: '' },
  // 'sb': { prefix: 'sb', domain: 'sahihalbukhari.com', pathPrefix: 'sps/sbk' },
};

const ALLOWED_DOMAINS: ReadonlyArray<AllowedDomain> = Object.values(DOMAIN_CONFIGS).map(config => config.domain);

// Reverse mapping for domain to config
const DOMAIN_TO_CONFIG: Record<AllowedDomain, DomainConfig> = Object.values(DOMAIN_CONFIGS).reduce((acc, config) => {
  acc[config.domain] = config;
  return acc;
}, {} as Record<AllowedDomain, DomainConfig>);

class HtmlModifier {
  private readonly config: DomainConfig;

  constructor(domain: AllowedDomain) {
    this.config = DOMAIN_TO_CONFIG[domain];
  }
  modifyHtml(html: string): string {
    // Add UTF-8 meta tag if not present
    if (!html.includes('<meta charset="utf-8"')) {
      html = html.replace('</head>', '<meta charset="utf-8">\n</head>');
    }

    return html
      // Replace absolute URLs with prefixed proxy URLs
      .replace(
        new RegExp(`(href|src)=["']https?://(${ALLOWED_DOMAINS.join('|')})/(?:${Object.values(DOMAIN_CONFIGS).map(c => c.pathPrefix).join('|')})/`, 'g'),
        (match, attr, domain) => `${attr}="/${DOMAIN_TO_CONFIG[domain as AllowedDomain].prefix}/`
      )
      // Replace root-relative URLs starting with the path prefix
      .replace(
        new RegExp(`(href|src)=["']/(?:${this.config.pathPrefix})/`, 'g'),
        `$1="/${this.config.prefix}/`
      )
      // Replace other root-relative URLs
      .replace(
        new RegExp(`(href|src)=["']/(?!${this.config.prefix})`, 'g'),
        `$1="/${this.config.prefix}/`
      )
      // Replace relative URLs
      .replace(
        new RegExp(`(href|src)=["'](?!http|https|//)([^"']*)["']`, 'g'),
        `$1="/${this.config.prefix}/$2"`
      );
  }
}

class ProxyHandler {
  private readonly req: Request;
  private readonly res: Response;
  private readonly FORBIDDEN_HEADERS = new Set([
    'host',
    'connection',
    'content-length',
    'transfer-encoding',
    'keep-alive',
    'upgrade',
    'expect',
    'proxy-connection'
  ]);

  constructor(req: Request, res: Response) {
    this.req = req;
    this.res = res;
  }

  private normalizeReferer(referer: string | undefined, domainConfig: DomainConfig): string {
    if (!referer) {
      return `http://${domainConfig.domain}/${domainConfig.pathPrefix}/`;
    }

    // Extract the path from the referer if it's from our proxy
    const refererUrl = new URL(referer, `http://${this.req.headers.host}`);
    const pathParts = refererUrl.pathname.split('/').filter(Boolean);

    // Check if the first part is a domain prefix
    if (pathParts[0] && DOMAIN_CONFIGS[pathParts[0]]) {
      // console.log('Referer:', referer, 'Path parts:', pathParts);
      const config = DOMAIN_CONFIGS[pathParts[0]];
      const originalPath = pathParts.slice(1).join('/');
      // console.log('Original path:', originalPath);
      return `http://${config.domain}/${config.pathPrefix}/${originalPath}${refererUrl.search}`;
    }

    return `http://${domainConfig.domain}/${domainConfig.pathPrefix}/`;
  }

  private getForwardableHeaders(domainConfig: DomainConfig): Record<string, string> {
    const headers: Record<string, string> = {};

    for (const [key, value] of Object.entries(this.req.headers)) {
      const lowerKey = key.toLowerCase();
      if (value && !this.FORBIDDEN_HEADERS.has(lowerKey) && lowerKey !== 'referer' && !lowerKey.startsWith('sec-fetch')) {
        headers[key] = Array.isArray(value) ? value[0] : value;
      }
    }

    headers.host = domainConfig.domain;
    headers.referer = this.normalizeReferer(this.req.headers.referer, domainConfig);

    if (['POST', 'PUT', 'DELETE'].includes(this.req.method)) {
      headers.origin = `http://${domainConfig.domain}`;
    }

    return headers;
  }

  private handleNonHtmlResponse(response: FetchResponse): void {
    console.log("Non-HTML response:", response.headers.get('content-type'));
    for (const [key, value] of response.headers.entries()) {
      if (!this.FORBIDDEN_HEADERS.has(key.toLowerCase())) {
        this.res.setHeader(key, value);
      }
    }
    response.body.pipe(this.res);
  }

  public async handle(): Promise<void> {
    try {
      const pathParts = this.req.url.split('/').filter(Boolean);
      if (pathParts.length === 0) {
        return;
      }

      // Get domain config from prefix
      const prefix = pathParts[0];
      const domainConfig = DOMAIN_CONFIGS[prefix];

      if (!domainConfig) {
        // console.log('Invalid prefix:', prefix);
        return;
      }

      // Remove the prefix and add the site's path prefix
      const targetPath = pathParts.slice(1).join('/');

      // Construct the target URL, ensuring the site's path prefix is included
      const targetUrl = `http://${domainConfig.domain}/${domainConfig.pathPrefix}/${targetPath}`;
      // console.log('Proxying to:', targetUrl);

      const headers = this.getForwardableHeaders(domainConfig);

      const fetchOptions: RequestInit = {
        method: this.req.method,
        headers,
        body: this.req.method !== 'GET' ? this.req : undefined,
        redirect: 'manual',
      };

      let response = await fetch(targetUrl, fetchOptions);

      // Handle redirects
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          // Update location header to use our proxy
          const newLocation = location.replace(
            new RegExp(`^https?://${domainConfig.domain}/${domainConfig.pathPrefix}/`),
            `/${domainConfig.prefix}/`
          );
          response.headers.set('location', newLocation);
        }
      }

      // Set status code from the final response
      this.res.status(response.status);

      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('text/html')) {
        await this.handleHtmlResponse(response, domainConfig.domain);
      } else {
        this.handleNonHtmlResponse(response);
      }
    } catch (error) {
      const proxyError = error;
      console.error('Proxy error:', proxyError);
      this.res.status(proxyError.status || 500).send(proxyError.message || 'Proxy request failed');
    }
  }

  private async handleHtmlResponse(response: FetchResponse, domain: AllowedDomain): Promise<void> {
    // First try UTF-8
    let buffer = await response.arrayBuffer();

    const domainToEncoding = {
      'salafitalk.net': 'iso-8859-1',
      'sahihmuslim.com': 'windows-1256',
      'salafitalk.com': 'iso-8859-1',
    }

    const encoding = domainToEncoding[domain];
    const text = iconv.decode(Buffer.from(buffer), encoding);


    if (!text) {
      console.error('Failed to decode text');
      this.res.status(500).send('Failed to decode text');
      return;
    }


    const htmlModifier = new HtmlModifier(domain);
    const modifiedHtml = htmlModifier.modifyHtml(text);

    // Always serve as UTF-8
    this.res.setHeader('Content-Type', 'text/html; charset=utf-8');
    this.res.send(modifiedHtml);
  }

}

class ProxyServer {
  private readonly app: express.Application;
  private readonly port: number;

  constructor(port: number = 3000) {
    this.app = express();
    this.port = port;
    this.setupRoutes();
  }

  private renderHomePage(): string {
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Islamic Sites Reader</title>
          <meta charset="utf-8">
          <style>
            body {
              font-family: system-ui, -apple-system, sans-serif;
              max-width: 800px;
              margin: 2rem auto;
              padding: 0 1rem;
              line-height: 1.5;
            }
            .site-list {
              display: grid;
              gap: 1rem;
              margin-top: 2rem;
            }
            .site-link {
              padding: 1rem;
              border: 1px solid #ddd;
              border-radius: 0.5rem;
              text-decoration: none;
              color: inherit;
              transition: all 0.2s ease;
            }
            .site-link:hover {
              background: #f5f5f5;
              transform: translateY(-1px);
              box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }
            .site-name {
              margin: 0;
              font-size: 1.25rem;
              color: #2563eb;
            }
          </style>
        </head>
        <body>
          <h1>Islamic Sites Reader</h1>
          <p>Select a site to read with proper Arabic text encoding:</p>
          <div class="site-list">
            ${Object.entries(DOMAIN_CONFIGS).map(([prefix, config]) => `
              <a href="/${prefix}/" class="site-link">
                <h2 class="site-name">${config.domain}</h2>
              </a>
            `).join('')}
          </div>
        </body>
      </html>
    `;
  }

  private setupRoutes(): void {
    this.app.use('/', async (req: Request, res: Response) => {
      if (req.url === '/') {
        res.send(this.renderHomePage());
      } else {
        const handler = new ProxyHandler(req, res);
        await handler.handle();
      }
    });
  }

  public start(): void {
    this.app.listen(this.port, () => {
      console.log(`Proxy server running on http://localhost:${this.port}`);
    });
  }
}

// Start server
const server = new ProxyServer(process.env.PORT ? parseInt(process.env.PORT) : 3000);
server.start();