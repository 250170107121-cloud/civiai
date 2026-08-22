import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { initMasterDataStore, DataStore } from './server/dataStore';
import { analyzeComplaintWithGemini } from './server/geminiService';
import { User, CountryCode, LanguageCode } from './src/types';

dotenv.config();

// Initialize Excel and Master Data
initMasterDataStore();

const app = express();
const PORT = 3000;

// Body parser for JSON and Base64 images/audio
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Simple in-memory token map for session verification
const userTokens = new Map<string, User>();

function authenticateUser(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }
  const token = authHeader.replace('Bearer ', '');
  const user = userTokens.get(token);
  if (!user) {
    return res.status(401).json({ error: 'Session expired or invalid. Please sign in.' });
  }
  (req as any).user = user;
  next();
}

function requireGovernmentRole(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user as User;
  if (!user || user.role !== 'government') {
    return res.status(403).json({ error: 'Forbidden: Access restricted to verified Government Officers.' });
  }
  next();
}

// ----------------------------------------------------
// AUTHENTICATION ROUTES
// ----------------------------------------------------

app.post('/api/auth/demo-citizen', (req, res) => {
  const user = DataStore.getUserById('USR-CIT-001') || {
    user_id: 'USR-CIT-001',
    name: 'Aarav Patel',
    email: 'citizen.demo@civicai.org',
    role: 'citizen',
    country_id: 'india',
    region: 'Gujarat',
    city: 'Ahmedabad',
    preferred_language: 'gu',
    latitude: 23.0225,
    longitude: 72.5714,
    civic_points: 125,
    created_at: new Date().toISOString(),
    is_demo: true
  };

  const token = `tok_cit_demo_${Date.now()}`;
  userTokens.set(token, user);
  res.json({ token, user });
});

app.post('/api/auth/demo-government', (req, res) => {
  const user = DataStore.getUserById('USR-GOV-001') || {
    user_id: 'USR-GOV-001',
    name: 'Dr. Rajesh Sharma, IAS',
    email: 'officer.demo@civicai.gov.in',
    role: 'government',
    country_id: 'india',
    region: 'Gujarat',
    city: 'Ahmedabad',
    preferred_language: 'en',
    latitude: 23.0225,
    longitude: 72.5714,
    civic_points: 0,
    created_at: new Date().toISOString(),
    department: 'Urban Infrastructure & Municipal Works',
    designation: 'Chief Municipal Engineer',
    is_demo: true
  };

  const token = `tok_gov_demo_${Date.now()}`;
  userTokens.set(token, user);
  res.json({ token, user });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password, role } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  let user = DataStore.getUserByEmail(email);

  if (!user) {
    if (role === 'government') {
      return res.status(401).json({ error: 'Government credentials not recognized. Please use official municipal ID or click Demo Government Officer.' });
    }
    // Auto-create standard citizen account if registering on the fly
    const newUserId = `USR-CIT-${Math.floor(1000 + Math.random() * 9000)}`;
    user = {
      user_id: newUserId,
      name: email.split('@')[0].replace(/[._]/g, ' '),
      email,
      role: 'citizen',
      country_id: 'india',
      region: 'Gujarat',
      city: 'Ahmedabad',
      preferred_language: 'en',
      latitude: 23.0225,
      longitude: 72.5714,
      civic_points: 50,
      created_at: new Date().toISOString()
    };
    DataStore.addUser(user);
  }

  if (role && user.role !== role) {
    return res.status(403).json({ error: `Account role mismatch. This account is registered as ${user.role}.` });
  }

  const token = `tok_${user.user_id}_${Date.now()}`;
  userTokens.set(token, user);
  res.json({ token, user });
});

app.post('/api/auth/register', (req, res) => {
  const { name, email, country_id, preferred_language, region, city, latitude, longitude } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }

  const existing = DataStore.getUserByEmail(email);
  if (existing) {
    const token = `tok_${existing.user_id}_${Date.now()}`;
    userTokens.set(token, existing);
    return res.json({ token, user: existing });
  }

  const newUserId = `USR-CIT-${Math.floor(10000 + Math.random() * 90000)}`;
  const newUser: User = {
    user_id: newUserId,
    name,
    email,
    role: 'citizen',
    country_id: country_id || 'india',
    region: region || 'Gujarat',
    city: city || 'Ahmedabad',
    preferred_language: preferred_language || 'en',
    latitude: Number(latitude) || 23.0225,
    longitude: Number(longitude) || 72.5714,
    civic_points: 50,
    created_at: new Date().toISOString()
  };

  DataStore.addUser(newUser);

  // Initial welcome notification
  DataStore.get().notifications.unshift({
    notification_id: `NOTIF-${Date.now()}`,
    user_id: newUserId,
    notification_type: 'Points Earned',
    title_key: 'notifications.pointsTitle',
    message_key: 'notifications.pointsMsg',
    title: 'Welcome to CivicAI',
    message: 'Welcome! You received +50 civic onboarding points for registering as a citizen advocate.',
    created_at: new Date().toISOString(),
    is_read: false
  });

  const token = `tok_${newUserId}_${Date.now()}`;
  userTokens.set(token, newUser);
  res.json({ token, user: newUser });
});

app.get('/api/auth/me', authenticateUser, (req, res) => {
  const user = (req as any).user as User;
  const fresh = DataStore.getUserById(user.user_id) || user;
  res.json({ user: fresh });
});

app.post('/api/user/preferences', authenticateUser, (req, res) => {
  const user = (req as any).user as User;
  const { preferred_language, region, city, latitude, longitude } = req.body;

  const updates: Partial<User> = {};
  if (preferred_language) updates.preferred_language = preferred_language as LanguageCode;
  // NOTE: Country cannot be directly changed here; must use /api/country/verify-and-switch
  if (region) updates.region = region;
  if (city) updates.city = city;
  if (latitude !== undefined) updates.latitude = Number(latitude);
  if (longitude !== undefined) updates.longitude = Number(longitude);

  const updated = DataStore.updateUser(user.user_id, updates);
  if (updated) {
    // update in session
    const authHeader = req.headers.authorization?.replace('Bearer ', '');
    if (authHeader) userTokens.set(authHeader, updated);
    res.json({ success: true, user: updated });
  } else {
    res.status(404).json({ error: 'User not found' });
  }
});

// Secure Country Change & ID Verification Endpoint
app.post('/api/country/verify-and-switch', authenticateUser, (req, res) => {
  const user = (req as any).user as User;
  const { requested_country_id, id_type, id_number, demo_code } = req.body;

  if (!requested_country_id) {
    return res.status(400).json({ error: 'Target country is required.' });
  }
  if (!id_number) {
    return res.status(400).json({ 
      success: false,
      error: '✕ Country verification failed. ID number or demo reference is required.' 
    });
  }

  const result = DataStore.verifyAndSwitchUserCountry(
    user.user_id,
    requested_country_id,
    id_type,
    id_number,
    demo_code
  );

  if (!result.success) {
    return res.status(400).json({
      success: false,
      error: result.error || '✕ Country verification failed. Your country was not changed.'
    });
  }

  // Update in session cache
  const authHeader = req.headers.authorization?.replace('Bearer ', '');
  if (authHeader && result.user) {
    userTokens.set(authHeader, result.user);
  }

  res.json({
    success: true,
    message: '✓ Country changed successfully.',
    user: result.user,
    verificationRecord: result.verificationRecord,
    newCountry: result.newCountry
  });
});

app.get('/api/country/verification-history', authenticateUser, (req, res) => {
  const user = (req as any).user as User;
  const history = DataStore.getCountryVerificationHistory(user.role === 'government' ? undefined : user.user_id);
  res.json({ history });
});

// ----------------------------------------------------
// COMPLAINTS & MULTIMODAL REPORTING
// ----------------------------------------------------

app.get('/api/complaints', (req, res) => {
  const { country_id, category, status, priority, user_id } = req.query;
  const complaints = DataStore.getComplaints({
    country_id: country_id as string,
    category: category as string,
    status: status as string,
    priority: priority as string,
    user_id: user_id as string
  });
  res.json({ complaints });
});

app.get('/api/complaints/:id', (req, res) => {
  const complaint = DataStore.getComplaintById(req.params.id);
  if (!complaint) {
    return res.status(404).json({ error: 'Complaint not found.' });
  }
  res.json({ complaint });
});

app.post('/api/complaints', authenticateUser, async (req, res) => {
  try {
    const user = (req as any).user as User;
    const {
      title,
      description,
      category,
      problem_type,
      voice_transcription,
      language,
      country_id,
      region,
      city,
      latitude,
      longitude,
      address,
      media // array of { media_type, file_url, is_before_image }
    } = req.body;

    if (!title || !description) {
      return res.status(400).json({ error: 'Title and description are required.' });
    }

    // Call Gemini AI or deterministic fallback
    let imageBase64: string | undefined;
    const firstImage = (media || []).find((m: any) => m.media_type === 'image');
    if (firstImage && firstImage.file_url && firstImage.file_url.startsWith('data:image')) {
      imageBase64 = firstImage.file_url;
    }

    const aiResult = await analyzeComplaintWithGemini({
      title,
      description,
      category,
      problem_type,
      voice_transcription,
      country: country_id || user.country_id,
      city: city || user.city,
      imageBase64
    });

    const finalCategory = category || aiResult.category;
    const finalProblemType = problem_type || aiResult.problem_type;

    const created = DataStore.createComplaint(
      {
        user_id: user.user_id,
        user_name: user.name,
        country_id: (country_id || user.country_id) as CountryCode,
        region: region || user.region,
        city: city || user.city,
        category: finalCategory,
        problem_type: finalProblemType,
        title,
        description,
        original_text: description,
        voice_transcription: voice_transcription || '',
        language: (language || user.preferred_language) as LanguageCode,
        detected_language: aiResult.detected_language,
        latitude: Number(latitude) || user.latitude,
        longitude: Number(longitude) || user.longitude,
        address: address || `${city || user.city}, ${region || user.region}`,
        severity: aiResult.severity_score,
        status: 'Registered',
        priority_score: aiResult.priority.total_score,
        priority_level: aiResult.priority.priority_level,
        population_affected: 25000,
        estimated_project_scale: aiResult.severity_score > 80 ? 'Major' : 'Moderate',
        estimated_cost_min: 50000,
        estimated_cost_max: 150000,
        verification_status: aiResult.is_demo_ai ? 'AI-Verified' : 'AI-Verified'
      },
      media || [],
      {
        detected_language: aiResult.detected_language,
        category: finalCategory,
        problem_type: finalProblemType,
        severity_score: aiResult.severity_score,
        summary: aiResult.summary,
        similar_complaints_count: aiResult.similar_complaints_count,
        infrastructure_condition: aiResult.infrastructure_condition,
        population_impact: aiResult.population_impact,
        ai_recommendation: aiResult.ai_recommendation,
        is_demo_ai: aiResult.is_demo_ai
      },
      {
        total_score: aiResult.priority.total_score,
        priority_level: aiResult.priority.priority_level,
        severity_component: aiResult.priority.severity_component,
        population_component: aiResult.priority.population_component,
        infrastructure_gap_component: aiResult.priority.infrastructure_gap_component,
        alternative_availability_component: aiResult.priority.alternative_availability_component,
        critical_facility_component: aiResult.priority.critical_facility_component,
        similar_complaints_component: aiResult.priority.similar_complaints_component,
        explanation: aiResult.priority.explanation
      }
    );

    res.status(201).json({
      success: true,
      complaint_id: created.complaint.complaint_id,
      complaint: created.complaint,
      notification: created.notification,
      points_awarded: created.pointsAwarded
    });
  } catch (err: any) {
    console.error('Error in complaint submission:', err);
    res.status(500).json({ error: 'Unable to submit your complaint. Please try again.' });
  }
});

// Update complaint status (Government only)
app.post('/api/complaints/:id/status', authenticateUser, requireGovernmentRole, (req, res) => {
  const user = (req as any).user as User;
  const { status, remarks } = req.body;
  if (!status) {
    return res.status(400).json({ error: 'New status is required.' });
  }

  const result = DataStore.updateComplaintStatus(req.params.id, status, user.name, remarks);
  if (!result) {
    return res.status(404).json({ error: 'Complaint not found.' });
  }

  res.json({
    success: true,
    complaint: result.complaint,
    historyEntry: result.historyEntry,
    notification: result.notification
  });
});

// ----------------------------------------------------
// NOTIFICATIONS
// ----------------------------------------------------

app.get('/api/notifications', authenticateUser, (req, res) => {
  const user = (req as any).user as User;
  const notifications = DataStore.getNotifications(user.user_id);
  res.json({ notifications });
});

app.post('/api/notifications/:id/read', authenticateUser, (req, res) => {
  const notif = DataStore.markNotificationRead(req.params.id);
  res.json({ success: !!notif, notification: notif });
});

app.post('/api/notifications/read-all', authenticateUser, (req, res) => {
  const user = (req as any).user as User;
  DataStore.markAllNotificationsRead(user.user_id);
  res.json({ success: true });
});

// ----------------------------------------------------
// CIVIC ACTIVITIES & POINTS
// ----------------------------------------------------

app.get('/api/activities', authenticateUser, (req, res) => {
  const user = (req as any).user as User;
  const activities = DataStore.get().civicActivities;
  const participations = DataStore.get().activityParticipation.filter(p => p.user_id === user.user_id);
  const enriched = activities.map(a => ({
    ...a,
    user_has_joined: participations.some(p => p.activity_id === a.activity_id)
  }));
  res.json({ activities: enriched });
});

app.post('/api/activities/:id/join', authenticateUser, (req, res) => {
  const user = (req as any).user as User;
  const result = DataStore.joinActivity(user.user_id, req.params.id);
  if (!result) {
    return res.status(404).json({ error: 'Activity not found.' });
  }
  res.json({ success: true, ...result });
});

app.get('/api/points/history', authenticateUser, (req, res) => {
  const user = (req as any).user as User;
  const history = DataStore.get().civicPointHistory.filter(h => h.user_id === user.user_id);
  const currentUser = DataStore.getUserById(user.user_id) || user;
  res.json({
    total_points: currentUser.civic_points,
    history
  });
});

// ----------------------------------------------------
// INFRASTRUCTURE, DEMOGRAPHICS, CRITICAL FACILITIES, GAPS, PROJECTS, BRICS, HELPLINES
// ----------------------------------------------------

app.get('/api/projects', (req, res) => {
  const { country_id, status, category } = req.query as { country_id?: string; status?: string; category?: string };
  const projects = DataStore.getProjects({ country_id, status, category });
  res.json({ projects });
});

app.get('/api/infrastructure', (req, res) => {
  const { country_id, category, status } = req.query as { country_id?: string; category?: string; status?: string };
  const infrastructure = DataStore.getInfrastructure({ country_id, category, status });
  res.json({ infrastructure });
});

app.get('/api/demographics', (req, res) => {
  const { country_id } = req.query as { country_id?: string };
  const demographics = DataStore.getDemographics(country_id);
  res.json({ demographics });
});

app.get('/api/critical-facilities', (req, res) => {
  const { country_id, type } = req.query as { country_id?: string; type?: string };
  const facilities = DataStore.getCriticalFacilities({ country_id, type });
  res.json({ facilities });
});

app.get('/api/infrastructure-gaps', (req, res) => {
  const { country_id } = req.query as { country_id?: string };
  const gaps = DataStore.getInfrastructureGaps(country_id);
  res.json({ gaps });
});

app.get('/api/map/nearby-analysis', (req, res) => {
  const { lat, lng, radius_km, country_id } = req.query as { lat?: string; lng?: string; radius_km?: string; country_id?: string };
  if (!lat || !lng) {
    return res.status(400).json({ error: 'Latitude and Longitude query parameters are required.' });
  }

  const analysis = DataStore.getNearbyAnalysis(
    Number(lat),
    Number(lng),
    radius_km ? Number(radius_km) : 2,
    country_id
  );
  res.json({ analysis });
});

app.get('/api/helplines', (req, res) => {
  const { country_id } = req.query;
  let helplines = DataStore.get().helplines;
  if (country_id) {
    helplines = helplines.filter(h => h.country_id === country_id);
  }
  res.json({ helplines });
});

app.get('/api/countries', (req, res) => {
  res.json({ countries: DataStore.getCountries() });
});

app.get('/api/brics', (req, res) => {
  res.json({ brics: DataStore.getBricsImpact() });
});

// Government statistics
app.get('/api/stats/government', authenticateUser, requireGovernmentRole, (req, res) => {
  const { country_id } = req.query;
  let complaints = DataStore.get().complaints;
  let projects = DataStore.get().projects;

  if (country_id) {
    complaints = complaints.filter(c => c.country_id === country_id);
    projects = projects.filter(p => p.country_id === country_id);
  }

  const totalComplaints = complaints.length;
  const criticalComplaints = complaints.filter(c => c.priority_level === 'Critical').length;
  const activeProjects = projects.filter(p => p.status !== 'Completed').length;
  const resolvedCount = complaints.filter(c => c.status === 'Completed').length;
  const resolutionRate = totalComplaints > 0 ? Math.round((resolvedCount / totalComplaints) * 100) : 0;
  const populationBenefited = projects.reduce((acc, p) => acc + (p.population_benefited || 0), 0) + 145000;

  // Category counts
  const categoryMap: Record<string, number> = {};
  complaints.forEach(c => {
    categoryMap[c.category] = (categoryMap[c.category] || 0) + 1;
  });

  // Priority counts
  const priorityMap: Record<string, number> = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  complaints.forEach(c => {
    priorityMap[c.priority_level] = (priorityMap[c.priority_level] || 0) + 1;
  });

  res.json({
    kpi: {
      totalComplaints,
      criticalComplaints,
      activeProjects,
      resolvedCount,
      resolutionRate,
      populationBenefited,
      avgResolutionTimeDays: 3.2
    },
    categoryBreakdown: categoryMap,
    priorityDistribution: priorityMap
  });
});

// Excel Download Endpoint
app.get('/api/data/download-excel', (req, res) => {
  const excelPath = path.join(process.cwd(), 'data', 'CivicAI_Master_Data.xlsx');
  if (fs.existsSync(excelPath)) {
    res.download(excelPath, 'CivicAI_Master_Data.xlsx');
  } else {
    res.status(404).json({ error: 'Excel file not found.' });
  }
});

// ----------------------------------------------------
// VITE SPA MIDDLEWARE / STATIC ASSETS
// ----------------------------------------------------

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[CivicAI] Full-Stack Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
