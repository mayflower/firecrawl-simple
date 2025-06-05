import { Response } from "express";
import { v4 as uuidv4 } from "uuid";
import {
  CrawlRequest,
  crawlRequestSchema,
  CrawlResponse,
  legacyCrawlerOptions,
  legacyScrapeOptions,
  RequestWithAuth,
} from "./types";
import {
  addCrawlJob,
  addCrawlJobs,
  crawlToCrawler,
  lockURL,
  lockURLs,
  saveCrawl,
  StoredCrawl,
} from "../../lib/crawl-redis";
import { getScrapeQueue } from "../../services/queue-service";
import { addScrapeJobRaw } from "../../services/queue-jobs";
import { Logger } from "../../lib/logger";
import { getJobPriority } from "../../lib/job-priority";

/**
 * @openapi
 * /v1/crawl:
 *   post:
 *     tags:
 *       - Crawling
 *     summary: Start a new web crawling job
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - url
 *             properties:
 *               url:
 *                 type: string
 *                 format: uri
 *               maxDepth:
 *                 type: integer
 *                 minimum: 1
 *                 default: 2
 *               maxPages:
 *                 type: integer
 *                 minimum: 1
 *               timeout:
 *                 type: integer
 *                 minimum: 1000
 *               includeUrls:
 *                 type: array
 *                 items:
 *                   type: string
 *               excludeUrls:
 *                 type: array
 *                 items:
 *                   type: string
 *               scrapeOptions:
 *                 type: object
 *                 properties:
 *                   waitUntil:
 *                     type: string
 *                     enum: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2']
 *                   timeout:
 *                     type: integer
 *     responses:
 *       200:
 *         description: Success
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 id:
 *                   type: string
 *                   format: uuid
 *                 url:
 *                   type: string
 *                   format: uri
 */
export async function crawlController(
  req: RequestWithAuth<{}, CrawlResponse, CrawlRequest>,
  res: Response<CrawlResponse>
) {
  Logger.info(`[Crawl] /v1/crawl endpoint called with body: ${JSON.stringify(req.body)}`);
  req.body = crawlRequestSchema.parse(req.body);

  Logger.debug(`[Crawl] Request: ${JSON.stringify(req.body)}`);

  const id = uuidv4();

  const crawlerOptions = legacyCrawlerOptions(req.body);
  const pageOptions = legacyScrapeOptions(req.body.scrapeOptions);

  // TODO: @rafa, is this right? copied from v0
  if (Array.isArray(crawlerOptions.includes)) {
    for (const x of crawlerOptions.includes) {
      try {
        new RegExp(x);
      } catch (e) {
        return res.status(400).json({ success: false, error: e.message });
      }
    }
  }

  if (Array.isArray(crawlerOptions.excludes)) {
    for (const x of crawlerOptions.excludes) {
      try {
        new RegExp(x);
      } catch (e) {
        return res.status(400).json({ success: false, error: e.message });
      }
    }
  }

  const sc: StoredCrawl = {
    originUrl: req.body.url,
    crawlerOptions,
    pageOptions,
    team_id: req.auth.team_id,
    createdAt: Date.now(),
    plan: req.auth.plan,
  };

  const crawler = crawlToCrawler(id, sc);

  try {
    sc.robots = await crawler.getRobotsTxt();
  } catch (e) {
    Logger.debug(
      `[Crawl] Failed to get robots.txt (this is probably fine!): ${JSON.stringify(
        e
      )}`
    );
  }

  await saveCrawl(id, sc);

  const sitemap =
    sc.crawlerOptions.ignoreSitemap ?? true
      ? null
      : await crawler.tryGetSitemap();

  if (sitemap !== null && sitemap.length > 0) {
    let jobPriority = 20;
    // If it is over 1000, we need to get the job priority,
    // otherwise we can use the default priority of 20
    if (sitemap.length > 1000) {
      // set base to 21
      jobPriority = await getJobPriority({
        plan: req.auth.plan,
        team_id: req.auth.team_id,
        basePriority: 21,
      });
    }
    const jobs = sitemap.map((x) => {
      const url = x.url;
      const uuid = uuidv4();
      return {
        name: uuid,
        data: {
          url,
          mode: "single_urls",
          team_id: req.auth.team_id,
          crawlerOptions,
          pageOptions,
          webhookUrls: req.body.webhookUrls,
          webhookMetadata: req.body.webhookMetadata,
          origin: "api",
          crawl_id: id,
          sitemapped: true,
          v1: true,
        },
        opts: {
          jobId: uuid,
          priority: 20,
        },
      };
    });

    await lockURLs(
      id,
      jobs.map((x) => x.data.url)
    );
    await addCrawlJobs(
      id,
      jobs.map((x) => x.opts.jobId)
    );
    await getScrapeQueue().addBulk(jobs);
  } else {
    await lockURL(id, sc, req.body.url);
    const job = await addScrapeJobRaw(
      {
        url: req.body.url,
        mode: "single_urls",
        crawlerOptions: crawlerOptions,
        team_id: req.auth.team_id,
        pageOptions: pageOptions,
        webhookUrls: req.body.webhookUrls,
        webhookMetadata: req.body.webhookMetadata,
        origin: "api",
        crawl_id: id,
        v1: true,
      },
      {
        priority: 15,
      },
      uuidv4(),
      10
    );
    await addCrawlJob(id, job.id);
  }

  const protocol = process.env.ENV === "local" ? req.protocol : "https";

  return res.status(200).json({
    success: true,
    id,
    url: `${protocol}://${req.get("host")}/v1/crawl/${id}`,
  });
}
