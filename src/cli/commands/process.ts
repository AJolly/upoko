import path from "path";
import { promises as fs } from "fs";
import { run } from "../../util.js";
import { filenameToKeywords, processAudioFile } from "../../core/processors/audioProcessor.js";
import { buildAudioMetadata, generateOutputFilename } from "../../core/processors/metadataBuilder.js";
import {
  searchAudibleBooks,
  getProductByAsin,
  getBookInfo,
  getChaptersByAsin,
  getImageFromUrl,
} from "../../core/services/audibleService.js";
import {
  isFileProcessed,
  markFileProcessed,
  copyFile,
  renameFile,
  createOutputDirectory,
} from "../../core/services/fileService.js";
import { 
  AudibleSearchResponse, 
  ChapterSplitConfig, 
  SplitOptions, 
  AudioFormat 
} from "../../core/models/types.js";
import { displaySearchResults, displayProductDetail } from "../ui/display.js";
import {
  question,
  promptForSearchSelection,
  promptForManualKeywords,
  parseUserSelection,
} from "../ui/prompts.js";
import { mapAndJoinOnField } from "../../util.js";
import { splitAudioByChapters } from "../../core/processors/audioSplitter.js";

/**
 * Extract book number from filename or keywords
 * @param filenameOrKeywords The filename or search keywords
 * @returns The book number if found, or null
 */
function extractBookNumber(filenameOrKeywords: string): number | null {
  // Try to match "Book 3", "Book 003", "book 3", etc.
  const match = filenameOrKeywords.match(/\b(?:book|bk)\s+0*(\d+)\b/i);
  if (match && match[1]) {
    const bookNum = parseInt(match[1], 10);
    return isNaN(bookNum) ? null : bookNum;
  }
  return null;
}

/**
 * Find the best matching search result based on book number
 * @param searchResults The search results
 * @param bookNumber The book number to match
 * @returns The index of the best match, or -1 if no clear match
 */
function findBestMatch(searchResults: AudibleSearchResponse, bookNumber: number): number {
  if (!searchResults.products || searchResults.products.length === 0) {
    return -1;
  }

  // Look for exact book number matches in the title
  const exactMatches: number[] = [];
  for (let i = 0; i < searchResults.products.length; i++) {
    const product = searchResults.products[i];
    const title = product.title.toLowerCase();
    
    // Match patterns like "Book 3", "3", "He Who Fights with Monsters 3"
    // Prefer matches after "book" or at the end of the title, or as standalone number
    // Avoid matching "3" in "13", "30", "103", etc.
    const patterns = [
      // "Book 3" or "book 3" - highest priority
      new RegExp(`\\b(?:book|bk)\\s+${bookNumber}\\b`, 'i'),
      // "3" at the end of title (e.g., "He Who Fights with Monsters 3")
      new RegExp(`\\s+${bookNumber}\\b$`, 'i'),
      // "3" as standalone word (not part of larger number)
      new RegExp(`(?:^|\\s)${bookNumber}(?:\\s|$)`, 'i'),
    ];
    
    for (const pattern of patterns) {
      if (pattern.test(title)) {
        exactMatches.push(i);
        break;
      }
    }
  }

  // If there's exactly one exact match, return it
  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  // If multiple matches, prefer the first one (usually most relevant)
  if (exactMatches.length > 1) {
    return exactMatches[0];
  }

  return -1;
}

/**
 * Display search results and prompt for selection or manual keyword input
 * @param searchResults The API response to display
 * @param filenameOrKeywords Optional filename or keywords for smart matching
 * @returns Promise resolving to the selected product ASIN or null if manual search requested
 */
async function handleSearchResults(
  searchResults: AudibleSearchResponse,
  filenameOrKeywords?: string,
): Promise<string | null> {
  // Try smart matching if filename/keywords provided
  if (filenameOrKeywords) {
    const bookNumber = extractBookNumber(filenameOrKeywords);
    if (bookNumber !== null) {
      const bestMatchIndex = findBestMatch(searchResults, bookNumber);
      if (bestMatchIndex >= 0) {
        const matchedProduct = searchResults.products[bestMatchIndex];
        console.log(`\n   ✅ Auto-selected: "${matchedProduct.title}" (Book ${bookNumber})`);
        return matchedProduct.asin;
      }
    }
  }

  displaySearchResults(searchResults);
  
  const hasProducts = searchResults.products && searchResults.products.length > 0;
  const answer = await promptForSearchSelection(searchResults.total_results, hasProducts);
  
  if (answer === null) {
    return null; // Manual search requested
  }

  const selectedIndex = parseUserSelection(answer, searchResults.products.length);
  
  if (selectedIndex === -1) {
    console.error(
      "Invalid selection. Please enter a valid number from the list.",
    );
    return handleSearchResults(searchResults, filenameOrKeywords);
  }

  return searchResults.products[selectedIndex].asin;
}

/**
 * Process a single file to get chapters information and add tags
 * @param dryRunMode Whether to run in dry mode
 * @param originalFilePath The original file path for logging
 * @param filePath The path of the file to process
 * @param logFilePath Path to the log file
 * @param originalFilename The original filename from input directory (for log checking)
 * @param skipProcessed Whether to skip already processed files
 * @param splitAfterTagging Whether to split the file into chapters after tagging
 */
export async function processFile(
  dryRunMode: boolean,
  originalFilePath: string,
  filePath: string,
  logFilePath: string,
  originalFilename: string,
  skipProcessed: boolean = false,
  splitAfterTagging: boolean = false,
): Promise<void> {
  const filename = path.basename(filePath);
  
  // Check for already processed files FIRST - before any API calls or file operations
  if (skipProcessed) {
    const isProcessed = await isFileProcessed(logFilePath, originalFilename);
    if (isProcessed) {
      console.log(`\n📖 "${originalFilename}"`);
      console.log(`   ⏭️  Already processed, skipping...`);
      return;
    }
  }
  
  console.log(`\n📖 "${originalFilename}"`);

  let selectedAsin: string | null = null;
  let success = false;
  let title = "";

  try {
    // Extract keywords from filename
    let keywords = filenameToKeywords(filename);
    console.log(`   🔍 Searching: "${keywords}"`);

    let manualSearch = false;

    do {
      // If manual search was requested, ask for new keywords
      if (manualSearch) {
        keywords = await promptForManualKeywords();
        console.log(`   🔍 Searching: "${keywords}"`);
      }

      // First API call: Search for products
      const searchResults = await searchAudibleBooks(keywords);

      // Display results and get user selection (pass filename for smart matching)
      selectedAsin = await handleSearchResults(searchResults, filename);
      manualSearch = selectedAsin === null;
    } while (manualSearch);

    // Get product details and book information
    const [productDetail, bookInfo] = await Promise.all([
      getProductByAsin(selectedAsin!),
      getBookInfo(selectedAsin!),
    ]);

    displayProductDetail(productDetail);

    console.log("   📥 Fetching chapters and artwork...");
    const [chaptersData, image] = await Promise.all([
      getChaptersByAsin(selectedAsin!),
      getImageFromUrl(bookInfo.image),
    ]);

    // Build metadata
    const metadata = buildAudioMetadata(productDetail, bookInfo, chaptersData, image);

    // Process the audio file
    processAudioFile(dryRunMode, filePath, metadata);

    // Generate output filename and rename
    console.log("   ✅ Tagging complete!");
    const ext = path.extname(filePath).replace(".", "");
    const authors = mapAndJoinOnField()(productDetail.product.authors ?? []);
    const releaseYear = new Date(productDetail.product.release_date)
      .getFullYear()
      .toString();
    
    title = productDetail.product.title;
    const outputFilename = generateOutputFilename(title, authors, releaseYear, ext);
    const outputPath = path.join("./output", outputFilename);
    
    // Only rename if the destination doesn't already exist (avoid EBUSY errors)
    let finalFilePath = filePath; // Default to original path
    if (!dryRunMode) {
      try {
        await fs.access(outputPath);
        // Destination already exists, assume it was already renamed
        console.log(`   ℹ️  Output file already exists, skipping rename: ${outputFilename}`);
        finalFilePath = outputPath; // Use the existing renamed file
      } catch {
        // Destination doesn't exist, proceed with rename
        await renameFile(filePath, outputPath);
        finalFilePath = outputPath; // Use the newly renamed file
      }
    } else {
      run(dryRunMode, renameFile, filePath, outputPath);
      finalFilePath = outputPath;
    }

    success = true;
    
    // If splitting is requested, split the tagged file into chapters
    if (splitAfterTagging && success) {
      const taggedFilePath = dryRunMode ? filePath : finalFilePath;
      
      // Ask user for confirmation before splitting
      const splitConfirm = await question(
        `\nSplit "${title}" into ${chaptersData.chapters.length} chapter files? (y/n): `
      );
      
      if (splitConfirm.toLowerCase() === 'y' || splitConfirm.toLowerCase() === 'yes') {
        try {
          // Create split output directory
          const splitOutputDir = await createOutputDirectory(
            "./output/split",
            title,
            dryRunMode
          );
          
          // Detect format from tagged file
          const format = ext as AudioFormat;
          
          // For tag+split workflow, use the chapters we just embedded
          // This avoids re-fetching from API and uses the exact same data
          const splitConfig: ChapterSplitConfig = {
            bookTitle: title,
            chapters: chaptersData.chapters,
            metadata: metadata, // Include the full metadata with image
            outputDir: splitOutputDir,
            format,
          };
          
          const splitOptions: SplitOptions = {
            inputPath: taggedFilePath,
            outputDir: splitOutputDir,
            dryRun: dryRunMode,
            overwrite: false,
            format,
          };
          
          console.log(`\nSplitting "${title}" into chapters...`);
          console.log(`Output directory: ${splitOutputDir}`);
          
          const splitResult = await splitAudioByChapters(splitConfig, splitOptions);
          
          if (splitResult.success) {
            console.log(`\nSplit files location: ${splitOutputDir}`);
          } else {
            console.error(`\n❌ Split operation failed:`);
            splitResult.errors.forEach(error => console.error(`  - ${error}`));
          }
        } catch (splitError) {
          console.error(`\n❌ Error during splitting: ${splitError}`);
        }
      } else {
        console.log("Skipping split operation.");
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "User chose to skip this file") {
        console.log("Skipping this file and continuing to the next one.");
      } else {
        console.error(`Error processing file ${filename}:`, error.message);
      }
    } else {
      console.error(`Unknown error processing file ${filename}`);
    }
  } finally {
    run(
      dryRunMode,
      markFileProcessed,
      logFilePath,
      originalFilename, // Use original filename for log entry (not full path)
      selectedAsin ?? "",
      title,
      success,
    );
  }
}