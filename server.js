const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const Tesseract = require('tesseract.js');
const app = express();

app.use(cors());

// --- HELPER FUNCTIONS ---

const delay = (time) => new Promise(resolve => setTimeout(resolve, time));

async function solveCaptcha(page) {
    console.log('   > Capturing CAPTCHA image...');
    
    // Selectors for India Post CAPTCHA image
    const captchaSelector = '#ctl00_PlaceHolderMain_ucNewLegacyControl_imgCaptcha';
    
    try {
        await page.waitForSelector(captchaSelector, { timeout: 5000 });
        const captchaElement = await page.$(captchaSelector);
        
        if (!captchaElement) throw new Error("Captcha element not found");

        // Take a screenshot of strictly the captcha element
        const imageBuffer = await captchaElement.screenshot();

        // Use Tesseract to read text
        console.log('   > Analyzing text with AI...');
        const { data: { text } } = await Tesseract.recognize(imageBuffer, 'eng');
        
        // Clean the text (remove spaces, special chars that aren't math)
        let cleanText = text.replace(/[^0-9a-zA-Z\+\-\=]/g, '').trim();
        
        // Logic: If it looks like a math problem (e.g. 5+2=), solve it.
        // Otherwise, return the text as is.
        if (cleanText.includes('+') || cleanText.includes('-')) {
            cleanText = cleanText.replace('=', ''); // Remove equals sign
            try {
                // Safe evaluation of simple math
                const solution = new Function('return ' + cleanText)(); 
                console.log(`   > Math detected: ${cleanText} = ${solution}`);
                return solution.toString();
            } catch (e) {
                console.log(`   > Math eval failed, using raw text: ${cleanText}`);
            }
        }

        console.log(`   > Solved as: ${cleanText}`);
        return cleanText;
    } catch (err) {
        console.error("   > Error solving captcha:", err.message);
        return "0000"; // Return dummy to force retry if failed
    }
}

// --- MAIN TRACKING ROUTE ---

app.get('/track', async (req, res) => {
    const trackingId = req.query.id;
    if (!trackingId) return res.status(400).json({ error: 'Missing ID' });

    console.log(`\n--- NEW AUTO-TRACK REQUEST: ${trackingId} ---`);
    
    // Launch Browser (Headless = true means invisible)
    const browser = await puppeteer.launch({ 
        headless: true, 
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();
        // Set User Agent to look like a real chrome browser
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log('1. Navigating to India Post Tracking Page...');
        // Direct link to the tracking application
        await page.goto('https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx', { 
            waitUntil: 'networkidle2', timeout: 60000 
        });

        // Retry Loop (Because OCR isn't perfect, we try up to 3 times)
        let success = false;
        let attempts = 0;
        const maxAttempts = 3;

        while (!success && attempts < maxAttempts) {
            attempts++;
            console.log(`\n--- Attempt ${attempts}/${maxAttempts} ---`);

            // Input Tracking ID
            await page.type('#ctl00_PlaceHolderMain_ucNewLegacyControl_txtOrignlPgTrkId', trackingId);

            // Solve and Type Captcha
            const captchaResult = await solveCaptcha(page);
            
            // Clear previous captcha input if any
            await page.evaluate(() => document.getElementById('ctl00_PlaceHolderMain_ucNewLegacyControl_txtCaptcha').value = "");
            await page.type('#ctl00_PlaceHolderMain_ucNewLegacyControl_txtCaptcha', captchaResult);

            // Click Search
            console.log('2. Submitting form...');
            await page.click('#ctl00_PlaceHolderMain_ucNewLegacyControl_btnSearch');

            // Wait for result OR error message
            try {
                await Promise.race([
                    page.waitForSelector('.responsive-table', { timeout: 8000 }), // Success
                    page.waitForSelector('#ctl00_PlaceHolderMain_ucNewLegacyControl_lblMsg', { visible: true, timeout: 8000 }) // Error
                ]);

                // Check if success table exists
                const tableExists = await page.$('.responsive-table');
                
                if (tableExists) {
                    success = true;
                    console.log('3. Success! Tracking data found.');
                } else {
                    // Check error message
                    const errorMsg = await page.$eval('#ctl00_PlaceHolderMain_ucNewLegacyControl_lblMsg', el => el.innerText);
                    console.log(`   > Site Message: "${errorMsg}"`);
                    
                    if (attempts < maxAttempts) {
                        console.log('   > Retrying...');
                        // Click Refresh Captcha button if available, or reload page
                        // Usually easier to just reload page or click refresh button
                        // Here we reload the page to get a fresh start
                         await page.reload({ waitUntil: 'networkidle2' });
                    }
                }
            } catch (e) {
                console.log('   > Timeout waiting for response. Retrying...');
                await page.reload({ waitUntil: 'networkidle2' });
            }
        }

        if (!success) {
            throw new Error("Could not solve CAPTCHA after 3 attempts. Please try again.");
        }

        // Scrape the data
        const data = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('.responsive-table tr'));
            return rows.slice(1).map(row => {
                const cols = row.querySelectorAll('td');
                if (cols.length < 4) return null;
                return {
                    date: cols[0]?.innerText?.trim(),
                    time: cols[1]?.innerText?.trim(),
                    location: cols[2]?.innerText?.trim(),
                    status: cols[3]?.innerText?.trim(),
                    description: cols[3]?.innerText?.trim()
                };
            }).filter(item => item !== null);
        });

        res.json(data);

    } catch (error) {
        console.error("FATAL ERROR:", error.message);
        res.status(500).json({ error: error.message });
    } finally {
        await browser.close();
    }
});

app.listen(3000, () => console.log('Auto-Scraper running on port 3000'));