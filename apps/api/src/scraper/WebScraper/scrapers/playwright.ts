import axios from "axios";
import { generateRequestParams } from "../single_url";
import { universalTimeout } from "../global";
import { Logger } from "../../../lib/logger";

/**
 * Scrapes a URL with Playwright
 * @param url The URL to scrape
 * @param waitFor The time to wait for the page to load
 * @param headers The headers to send with the request
 * @param pageOptions The options for the page
 * @returns The scraped content
 */
export async function scrapeWithPlaywright(
  url: string,
  waitFor: number = 0,
  headers?: Record<string, string>,
): Promise<{ content: string; pageStatusCode?: number; pageError?: string }> {
  const logParams = {
    url,
    scraper: "playwright",
    success: false,
    response_code: null,
    time_taken_seconds: null,
    error_message: null,
    html: "",
    startTime: Date.now(),
  };

  try {
    const reqParams = await generateRequestParams(url);
    const waitParam = reqParams["params"]?.wait ?? waitFor;

    const serviceUrl = process.env.PLAYWRIGHT_MICROSERVICE_URL;
    const payload = {
      url: url,
      wait_after_load: waitParam,
      headers: headers,
    };

    Logger.info(`[scrapeWithPlaywright] Calling puppeteer-service at: ${serviceUrl} for URL: ${url}`);
    Logger.debug(`[scrapeWithPlaywright] Payload sent to puppeteer-service: ${JSON.stringify(payload)}`);

    let response;
    try {
      Logger.debug(`[scrapeWithPlaywright] Attempting axios.post to ${serviceUrl} with payload: ${JSON.stringify(payload)}`);
      response = await axios.post(
        serviceUrl,
        payload,
        {
          headers: {
            "Content-Type": "application/json",
          },
          timeout: universalTimeout + waitParam,
          transformResponse: [(data) => data],
        }
      );
      Logger.info(`[scrapeWithPlaywright] axios.post to ${serviceUrl} for ${url} completed with status: ${response.status}`);
    } catch (axiosError) {
      logParams.error_message = axiosError.message || String(axiosError);
      logParams.response_code = axiosError.response?.status;
      const detailedAxiosError = `[scrapeWithPlaywright] axios.post to ${serviceUrl} for ${url} FAILED. Error: ${axiosError.message}. Code: ${axiosError.code}. Request URL: ${serviceUrl}. Request Payload: ${JSON.stringify(payload)}. Response Status: ${axiosError.response?.status}. Response Data: ${JSON.stringify(axiosError.response?.data)}`;
      Logger.error(detailedAxiosError);
      return {
        content: "",
        pageStatusCode: axiosError.response?.status || null,
        pageError: logParams.error_message,
      };
    }

    if (response.status !== 200) {
      Logger.debug(
        `⛏️ Playwright: Failed to fetch url: ${url} | status: ${response.status}, error: ${response.data?.pageError}`
      );
      logParams.error_message = response.data?.pageError;
      logParams.response_code = response.data?.pageStatusCode;
      return {
        content: "",
        pageStatusCode: response.data?.pageStatusCode,
        pageError: response.data?.pageError,
      };
    }

    const textData = response.data;
    Logger.debug(`[scrapeWithPlaywright] Raw response from puppeteer-service for ${url}: ${textData.substring(0, 500)}...`); // Log first 500 chars
    try {
      const data = JSON.parse(textData);
      const html = data.content;
      logParams.success = true;
      logParams.html = html;
      logParams.response_code = data.pageStatusCode;
      logParams.error_message = data.pageError;
      return {
        content: html ?? "",
        pageStatusCode: data.pageStatusCode,
        pageError: data.pageError,
      };
    } catch (jsonError) {
      logParams.error_message = jsonError.message || jsonError;
      Logger.debug(
        `⛏️ Playwright: Error parsing JSON response for url: ${url} | Error: ${jsonError}`
      );
      return {
        content: "",
        pageStatusCode: null,
        pageError: logParams.error_message,
      };
    }
  } catch (error) {
    if (error.code === "ECONNABORTED") {
      logParams.error_message = "Request timed out";
      Logger.debug(`⛏️ Playwright: Request timed out for ${url}`);
    } else {
      logParams.error_message = error.message || error;
      Logger.debug(
        `⛏️ Playwright: Failed to fetch url: ${url} | Error: ${error}`
      );
    }
    return {
      content: "",
      pageStatusCode: null,
      pageError: logParams.error_message,
    };
  } finally {
    const endTime = Date.now();
    logParams.time_taken_seconds = (endTime - logParams.startTime) / 1000;
  }
}
