import { Document, PageOptions, WebScraperOptions } from "../../lib/entities";
import { Progress } from "../../lib/entities";
import { scrapeSingleUrl } from "./single_url";
import { SitemapEntry, fetchSitemapData, getLinksFromSitemap } from "./sitemap";
import { WebCrawler } from "./crawler";
import { getValue, setValue } from "../../services/redis";
import {
  replaceImgPathsWithAbsolutePaths,
  replacePathsWithAbsolutePaths,
} from "./utils/replacePaths";
import { getAdjustedMaxDepth, getURLDepth } from "./utils/maxDepthUtils";
import { Logger } from "../../lib/logger";

export class WebScraperDataProvider {
  private jobId: string;
  private crawlId: string;
  private urls: string[] = [""];
  private mode: "single_urls" | "sitemap" | "crawl" = "single_urls";
  private includes: string | string[];
  private excludes: string | string[];
  private maxCrawledLinks: number;
  private maxCrawledDepth: number = 10;
  private returnOnlyUrls: boolean;
  private limit: number = 10000;
  private concurrentRequests: number = 20;
  private ignoreSitemap: boolean = true;
  private pageOptions?: PageOptions;
  private webhookUrls?: string[];
  private webhookMetadata?: any;
  private replaceAllPathsWithAbsolutePaths?: boolean = false;
  private crawlerMode: string = "default";
  private allowExternalLinks: boolean = false;

  private async convertUrlsToDocuments(
    urls: string[],
    inProgress?: (progress: Progress) => void,
    allHtmls?: string[],
  ): Promise<Document[]> {
    const totalUrls = urls.length;
    let processedUrls = 0;

    const results: (Document | null)[] = new Array(urls.length).fill(null);
    for (let i = 0; i < urls.length; i += this.concurrentRequests) {
      const batchUrls = urls.slice(i, i + this.concurrentRequests);
      await Promise.all(
        batchUrls.map(async (url, index) => {
          const existingHTML = allHtmls ? allHtmls[i + index] : "";
          Logger.info(`[WebScraperDataProvider] Scraping URL: ${url} for crawlId: ${this.crawlId} (Job ID: ${this.jobId})`);
          Logger.debug(`[WebScraperDataProvider] PageOptions for ${url}: ${JSON.stringify(this.pageOptions)}`);
          const result = await scrapeSingleUrl(
            url,
            this.pageOptions,
            existingHTML,
            this.webhookUrls,
            this.webhookMetadata,
            this.crawlId,
          );
          processedUrls++;
          if (inProgress) {
            inProgress({
              current: processedUrls,
              total: totalUrls,
              status: "SCRAPING",
              currentDocumentUrl: url,
              currentDocument: { ...result, index: processedUrls },
            });
          }

          results[i + index] = result;
        }),
      );
    }
    return results.filter((result) => result !== null) as Document[];
  }

  async getDocuments(
    useCaching: boolean = false,
    inProgress?: (progress: Progress) => void,
  ): Promise<Document[]> {
    this.validateInitialUrl();
    if (!useCaching) {
      return this.processDocumentsWithoutCache(inProgress);
    }

    return this.processDocumentsWithCache(inProgress);
  }

  private validateInitialUrl(): void {
    if (this.urls[0].trim() === "") {
      throw new Error("Url is required");
    }
  }

  /**
   * Process documents without cache handling each mode
   * @param inProgress inProgress
   * @returns documents
   */
  private async processDocumentsWithoutCache(
    inProgress?: (progress: Progress) => void,
  ): Promise<Document[]> {
    switch (this.mode) {
      case "crawl":
        return this.handleCrawlMode(inProgress);
      case "single_urls":
        return this.handleSingleUrlsMode(inProgress);
      case "sitemap":
        return this.handleSitemapMode(inProgress);
      default:
        return [];
    }
  }

  private async cleanIrrelevantPath(links: string[]) {
    return links.filter((link) => {
      if (!link) {
        return false;
      }

      const normalizedInitialUrl = new URL(this.urls[0]);
      const normalizedLink = new URL(link);

      // Normalize the hostname to account for www and non-www versions
      const initialHostname = normalizedInitialUrl.hostname.replace(
        /^www\./,
        "",
      );
      const linkHostname = normalizedLink.hostname.replace(/^www\./, "");

      // Ensure the protocol and hostname match, and the path starts with the initial URL's path
      return (
        linkHostname === initialHostname &&
        normalizedLink.pathname.startsWith(normalizedInitialUrl.pathname)
      );
    });
  }

  private async handleCrawlMode(
    inProgress?: (progress: Progress) => void,
  ): Promise<Document[]> {
    let includes: string[];
    if (Array.isArray(this.includes)) {
      if (this.includes[0] != "") {
        includes = this.includes;
      }
    } else {
      includes = this.includes.split(",");
    }

    let excludes: string[];
    if (Array.isArray(this.excludes)) {
      if (this.excludes[0] != "") {
        excludes = this.excludes;
      }
    } else {
      excludes = this.excludes.split(",");
    }

    const crawler = new WebCrawler({
      jobId: this.jobId,
      initialUrl: this.urls[0],
      includes,
      excludes,
      maxCrawledLinks: this.maxCrawledLinks,
      maxCrawledDepth: getAdjustedMaxDepth(this.urls[0], this.maxCrawledDepth),
      limit: this.limit,
      allowExternalLinks: this.allowExternalLinks,
      crawlId: this.crawlId,
    });

    let links = await crawler.start(
      inProgress,
      this.pageOptions,
      {
        ignoreSitemap: this.ignoreSitemap,
      },
      5,
      this.limit,
      this.maxCrawledDepth,
    );

    let allLinks = links.map((e) => e.url);
    const allHtmls = links.map((e) => e.html);

    if (this.returnOnlyUrls) {
      return this.returnOnlyUrlsResponse(allLinks, inProgress);
    }

    let documents = [];
    // check if fast mode is enabled and there is html inside the links
    if (this.crawlerMode === "fast" && links.some((link) => link.html)) {
      documents = await this.processLinks(allLinks, inProgress, allHtmls);
    } else {
      documents = await this.processLinks(allLinks, inProgress);
    }

    return this.cacheAndFinalizeDocuments(documents, allLinks);
  }

  private async handleSingleUrlsMode(
    inProgress?: (progress: Progress) => void,
  ): Promise<Document[]> {
    const links = this.urls;

    let documents = await this.processLinks(links, inProgress);
    return documents;
  }

  private async handleSitemapMode(
    inProgress?: (progress: Progress) => void,
  ): Promise<Document[]> {
    let links = await getLinksFromSitemap({ sitemapUrl: this.urls[0] });
    links = await this.cleanIrrelevantPath(links);

    if (this.returnOnlyUrls) {
      return this.returnOnlyUrlsResponse(links, inProgress);
    }

    let documents = await this.processLinks(links, inProgress);
    return this.cacheAndFinalizeDocuments(documents, links);
  }

  private async returnOnlyUrlsResponse(
    links: string[],
    inProgress?: (progress: Progress) => void,
  ): Promise<Document[]> {
    inProgress?.({
      current: links.length,
      total: links.length,
      status: "COMPLETED",
      currentDocumentUrl: this.urls[0],
    });
    return links.map((url) => ({
      content: "",
      html: this.pageOptions?.includeRawHtml ? "" : undefined,
      markdown: "",
      metadata: { sourceURL: url, pageStatusCode: 200 },
    }));
  }

  private async processLinks(
    links: string[],
    inProgress?: (progress: Progress) => void,
    allHtmls?: string[],
  ): Promise<Document[]> {
    const pdfLinks = links.filter((link) => link.endsWith(".pdf"));
    const docLinks = links.filter(
      (link) => link.endsWith(".doc") || link.endsWith(".docx"),
    );

    links = links.filter(
      (link) => !pdfLinks.includes(link) && !docLinks.includes(link),
    );

    let [documents, sitemapData] = await Promise.all([
      this.convertUrlsToDocuments(links, inProgress, allHtmls),
      this.mode === "single_urls" && links.length > 0
        ? this.getSitemapDataForSingleUrl(this.urls[0], links[0], 1500).catch(
            (error) => {
              Logger.debug(`Failed to fetch sitemap data: ${error}`);
              return null;
            },
          )
        : Promise.resolve(null),
    ]);

    if (this.mode === "single_urls" && documents.length > 0) {
      documents[0].metadata.sitemap = sitemapData ?? undefined;
    } else {
      documents = await this.getSitemapData(this.urls[0], documents);
    }

    if (this.pageOptions.includeMarkdown) {
      documents = this.applyPathReplacements(documents);
    }

    return documents;
  }

  private applyPathReplacements(documents: Document[]): Document[] {
    if (this.replaceAllPathsWithAbsolutePaths) {
      documents = replacePathsWithAbsolutePaths(documents);
    }
    return replaceImgPathsWithAbsolutePaths(documents);
  }

  private async cacheAndFinalizeDocuments(
    documents: Document[],
    links: string[],
  ): Promise<Document[]> {
    // await this.setCachedDocuments(documents, links);
    documents = this.removeChildLinks(documents);
    return documents.splice(0, this.limit);
  }

  private async processDocumentsWithCache(
    inProgress?: (progress: Progress) => void,
  ): Promise<Document[]> {
    let documents = await this.getCachedDocuments(
      this.urls.slice(0, this.limit),
    );
    if (documents.length < this.limit) {
      const newDocuments: Document[] = await this.getDocuments(
        false,
        inProgress,
      );
      documents = this.mergeNewDocuments(documents, newDocuments);
    }
    documents = this.filterDocsExcludeInclude(documents);
    documents = this.filterDepth(documents);
    documents = this.removeChildLinks(documents);
    return documents.splice(0, this.limit);
  }

  private mergeNewDocuments(
    existingDocuments: Document[],
    newDocuments: Document[],
  ): Document[] {
    newDocuments.forEach((doc) => {
      if (
        !existingDocuments.some(
          (d) =>
            this.normalizeUrl(d.metadata.sourceURL) ===
            this.normalizeUrl(doc.metadata?.sourceURL),
        )
      ) {
        existingDocuments.push(doc);
      }
    });
    return existingDocuments;
  }

  private filterDocsExcludeInclude(documents: Document[]): Document[] {
    return documents.filter((document) => {
      const url = new URL(document.metadata.sourceURL);
      const path = url.pathname;

      if (!Array.isArray(this.excludes)) {
        this.excludes = this.excludes.split(",");
      }

      if (this.excludes.length > 0 && this.excludes[0] !== "") {
        // Check if the link should be excluded
        if (
          this.excludes.some((excludePattern) =>
            new RegExp(excludePattern).test(path),
          )
        ) {
          return false;
        }
      }

      if (!Array.isArray(this.includes)) {
        this.includes = this.includes.split(",");
      }

      if (this.includes.length > 0 && this.includes[0] !== "") {
        // Check if the link matches the include patterns, if any are specified
        if (this.includes.length > 0) {
          return this.includes.some((includePattern) =>
            new RegExp(includePattern).test(path),
          );
        }
      }
      return true;
    });
  }

  private normalizeUrl(url: string): string {
    if (url.includes("//www.")) {
      return url.replace("//www.", "//");
    }
    return url;
  }

  private removeChildLinks(documents: Document[]): Document[] {
    for (let document of documents) {
      if (document?.childrenLinks) delete document.childrenLinks;
    }
    return documents;
  }

  async setCachedDocuments(documents: Document[], childrenLinks?: string[]) {
    for (const document of documents) {
      if (document.content.trim().length === 0) {
        continue;
      }
      const normalizedUrl = this.normalizeUrl(document.metadata.sourceURL);
      await setValue(
        "web-scraper-cache:" + normalizedUrl,
        JSON.stringify({
          ...document,
          childrenLinks: childrenLinks || [],
        }),
        60 * 60,
      ); // 10 days
    }
  }

  async getCachedDocuments(urls: string[]): Promise<Document[]> {
    let documents: Document[] = [];
    for (const url of urls) {
      const normalizedUrl = this.normalizeUrl(url);
      Logger.debug(
        "Getting cached document for web-scraper-cache:" + normalizedUrl,
      );
      const cachedDocumentString = await getValue(
        "web-scraper-cache:" + normalizedUrl,
      );
      if (cachedDocumentString) {
        const cachedDocument = JSON.parse(cachedDocumentString);
        documents.push(cachedDocument);

        // get children documents
        for (const childUrl of cachedDocument.childrenLinks || []) {
          const normalizedChildUrl = this.normalizeUrl(childUrl);
          const childCachedDocumentString = await getValue(
            "web-scraper-cache:" + normalizedChildUrl,
          );
          if (childCachedDocumentString) {
            const childCachedDocument = JSON.parse(childCachedDocumentString);
            if (
              !documents.find(
                (doc) =>
                  doc.metadata.sourceURL ===
                  childCachedDocument.metadata.sourceURL,
              )
            ) {
              documents.push(childCachedDocument);
            }
          }
        }
      }
    }
    return documents;
  }

  setOptions(options: WebScraperOptions): void {
    if (!options.urls) {
      throw new Error("Urls are required");
    }

    this.jobId = options.jobId;
    this.crawlId = options.crawlId;
    this.urls = options.urls;
    this.mode = options.mode;
    this.concurrentRequests = options.concurrentRequests ?? 20;
    this.includes = options.crawlerOptions?.includes ?? [];
    this.excludes = options.crawlerOptions?.excludes ?? [];
    this.maxCrawledLinks = options.crawlerOptions?.maxCrawledLinks ?? 1000;
    this.maxCrawledDepth = options.crawlerOptions?.maxDepth ?? 10;
    this.returnOnlyUrls = options.crawlerOptions?.returnOnlyUrls ?? false;
    this.limit = options.crawlerOptions?.limit ?? 10000;
    this.pageOptions = {
      replaceAllPathsWithAbsolutePaths:
        options.pageOptions?.replaceAllPathsWithAbsolutePaths ?? true,
      parsePDF: options.pageOptions?.parsePDF ?? true,
      onlyIncludeTags: options.pageOptions?.onlyIncludeTags ?? [],
      removeTags: options.pageOptions?.removeTags ?? [],
      includeMarkdown: options.pageOptions?.includeMarkdown ?? true,
      includeRawHtml: options.pageOptions?.includeRawHtml ?? false,
      waitFor: options.pageOptions?.waitFor ?? undefined,
      headers: options.pageOptions?.headers ?? undefined,
      includeLinks: options.pageOptions?.includeLinks ?? true,
      fullPageScreenshot: options.pageOptions?.fullPageScreenshot ?? false,
      screenshot: options.pageOptions?.screenshot ?? false,
      useFastMode: options.pageOptions?.useFastMode ?? false,
      disableJsDom: options.pageOptions?.disableJsDom ?? false,
      atsv: options.pageOptions?.atsv ?? false,
    };
    this.webhookUrls = options.webhookUrls;
    this.webhookMetadata = options.webhookMetadata;
    this.replaceAllPathsWithAbsolutePaths =
      options.crawlerOptions?.replaceAllPathsWithAbsolutePaths ??
      options.pageOptions?.replaceAllPathsWithAbsolutePaths ??
      false;

    if (typeof options.crawlerOptions?.excludes === "string") {
      this.excludes = options.crawlerOptions?.excludes
        .split(",")
        .filter((item) => item.trim() !== "");
    }

    if (typeof options.crawlerOptions?.includes === "string") {
      this.includes = options.crawlerOptions?.includes
        .split(",")
        .filter((item) => item.trim() !== "");
    }

    this.crawlerMode = options.crawlerOptions?.mode ?? "default";
    this.ignoreSitemap = options.crawlerOptions?.ignoreSitemap ?? true;
    this.allowExternalLinks =
      options.crawlerOptions?.allowExternalLinks ?? false;

    this.urls = this.urls.map((url) => {
      if (!url.trim().startsWith("http")) {
        return `https://${url}`;
      }
      return url;
    });
  }

  private async getSitemapData(baseUrl: string, documents: Document[]) {
    const sitemapData = await fetchSitemapData(baseUrl);
    if (sitemapData) {
      for (let i = 0; i < documents.length; i++) {
        const docInSitemapData = sitemapData.find(
          (data) =>
            this.normalizeUrl(data.loc) ===
            this.normalizeUrl(documents[i].metadata.sourceURL),
        );
        if (docInSitemapData) {
          let sitemapDocData: Partial<SitemapEntry> = {};
          if (docInSitemapData.changefreq) {
            sitemapDocData.changefreq = docInSitemapData.changefreq;
          }
          if (docInSitemapData.priority) {
            sitemapDocData.priority = Number(docInSitemapData.priority);
          }
          if (docInSitemapData.lastmod) {
            sitemapDocData.lastmod = docInSitemapData.lastmod;
          }
          if (Object.keys(sitemapDocData).length !== 0) {
            documents[i].metadata.sitemap = sitemapDocData;
          }
        }
      }
    }
    return documents;
  }
  private async getSitemapDataForSingleUrl(
    baseUrl: string,
    url: string,
    timeout?: number,
  ) {
    const sitemapData = await fetchSitemapData(baseUrl, timeout);
    if (sitemapData) {
      const docInSitemapData = sitemapData.find(
        (data) => this.normalizeUrl(data.loc) === this.normalizeUrl(url),
      );
      if (docInSitemapData) {
        let sitemapDocData: Partial<SitemapEntry> = {};
        if (docInSitemapData.changefreq) {
          sitemapDocData.changefreq = docInSitemapData.changefreq;
        }
        if (docInSitemapData.priority) {
          sitemapDocData.priority = Number(docInSitemapData.priority);
        }
        if (docInSitemapData.lastmod) {
          sitemapDocData.lastmod = docInSitemapData.lastmod;
        }
        if (Object.keys(sitemapDocData).length !== 0) {
          return sitemapDocData;
        }
      }
    }
    return null;
  }

  filterDepth(documents: Document[]): Document[] {
    return documents.filter((document) => {
      const url = new URL(document.metadata.sourceURL);
      return getURLDepth(url.toString()) <= this.maxCrawledDepth;
    });
  }
}
