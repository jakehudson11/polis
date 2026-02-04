import { marked } from "marked";
import logger from "../utils/logger";

/**
 * Service for converting markdown to PDF
 */
class PdfService {
  /**
   * Convert markdown to HTML with proper styling for PDF generation
   */
  private markdownToHtml(markdown: string, title: string): string {
    // Configure marked options
    marked.setOptions({
      gfm: true,
      breaks: true,
    });

    const htmlContent = marked.parse(markdown);

    // Build complete HTML document with styling
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${this.escapeHtml(title)} - Research Dossier</title>
  <style>
    @page {
      margin: 2cm;
      size: A4;
    }
    
    body {
      font-family: 'Georgia', 'Times New Roman', serif;
      font-size: 11pt;
      line-height: 1.6;
      color: #1a1a1a;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
    }
    
    h1 {
      font-size: 24pt;
      font-weight: bold;
      margin-top: 24pt;
      margin-bottom: 12pt;
      color: #2c3e50;
      page-break-after: avoid;
    }
    
    h2 {
      font-size: 18pt;
      font-weight: bold;
      margin-top: 18pt;
      margin-bottom: 10pt;
      color: #34495e;
      page-break-after: avoid;
      border-bottom: 2px solid #e0e0e0;
      padding-bottom: 6pt;
    }
    
    h3 {
      font-size: 14pt;
      font-weight: bold;
      margin-top: 14pt;
      margin-bottom: 8pt;
      color: #555;
      page-break-after: avoid;
    }
    
    h4 {
      font-size: 12pt;
      font-weight: bold;
      margin-top: 12pt;
      margin-bottom: 6pt;
      color: #666;
      page-break-after: avoid;
    }
    
    p {
      margin-top: 0;
      margin-bottom: 12pt;
      text-align: justify;
    }
    
    ul, ol {
      margin-top: 6pt;
      margin-bottom: 12pt;
      padding-left: 24pt;
    }
    
    li {
      margin-bottom: 6pt;
    }
    
    blockquote {
      margin: 16pt 0;
      padding: 12pt 16pt;
      background-color: #f9f9f9;
      border-left: 4pt solid #4a5568;
      font-style: italic;
      page-break-inside: avoid;
    }
    
    code {
      font-family: 'Courier New', monospace;
      font-size: 10pt;
      background-color: #f5f5f5;
      padding: 2pt 4pt;
      border-radius: 3pt;
    }
    
    pre {
      background-color: #f5f5f5;
      padding: 12pt;
      border-radius: 4pt;
      overflow-x: auto;
      page-break-inside: avoid;
    }
    
    pre code {
      background-color: transparent;
      padding: 0;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 16pt 0;
      page-break-inside: avoid;
    }
    
    th, td {
      border: 1pt solid #ddd;
      padding: 8pt;
      text-align: left;
    }
    
    th {
      background-color: #f2f2f2;
      font-weight: bold;
    }
    
    a {
      color: #2563eb;
      text-decoration: none;
    }
    
    a:hover {
      text-decoration: underline;
    }
    
    hr {
      border: none;
      border-top: 1pt solid #ddd;
      margin: 20pt 0;
    }
    
    .cover-page {
      text-align: center;
      padding: 100pt 0;
      page-break-after: always;
    }
    
    .cover-title {
      font-size: 32pt;
      font-weight: bold;
      color: #1a1a1a;
      margin-bottom: 20pt;
    }
    
    .cover-subtitle {
      font-size: 16pt;
      color: #666;
      margin-bottom: 40pt;
    }
    
    .cover-date {
      font-size: 12pt;
      color: #888;
    }
    
    .page-break {
      page-break-after: always;
    }
    
    @media print {
      body {
        font-size: 10pt;
      }
      
      a {
        color: #000;
        text-decoration: underline;
      }
      
      a[href]:after {
        content: " (" attr(href) ")";
        font-size: 9pt;
        color: #666;
      }
    }
  </style>
  <script>
    // Auto-trigger print dialog when HTML is opened
    window.addEventListener('load', function() {
      // Small delay to ensure content is fully rendered
      setTimeout(function() {
        window.print();
      }, 500);
    });
  </script>
</head>
<body>
  <div class="cover-page">
    <div class="cover-title">${this.escapeHtml(title)}</div>
    <div class="cover-subtitle">Research Dossier for Deliberative Democracy</div>
    <div class="cover-date">Generated: ${new Date().toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    })}</div>
  </div>
  
  <div class="content">
    ${htmlContent}
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Escape HTML special characters
   */
  private escapeHtml(text: string): string {
    const map: { [key: string]: string } = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }

  /**
   * Generate PDF from markdown content
   * For now, returns HTML that can be converted to PDF client-side or via puppeteer
   * @param markdown - Markdown content
   * @param title - Document title
   * @returns HTML string ready for PDF conversion
   */
  async generatePdfHtml(markdown: string, title: string): Promise<string> {
    try {
      logger.info("Generating PDF HTML", {
        markdownLength: markdown.length,
        title: title.substring(0, 50),
      });

      const html = this.markdownToHtml(markdown, title);

      logger.info("PDF HTML generated successfully", {
        htmlLength: html.length,
      });

      return html;
    } catch (error: any) {
      logger.error("Failed to generate PDF HTML", {
        error: error.message,
        stack: error.stack,
      });
      throw new Error(`Failed to generate PDF: ${error.message}`);
    }
  }
}

// Export singleton instance
let pdfServiceInstance: PdfService | null = null;

export function getPdfService(): PdfService {
  if (!pdfServiceInstance) {
    pdfServiceInstance = new PdfService();
  }
  return pdfServiceInstance;
}

export default PdfService;

