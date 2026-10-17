import Fastify from 'fastify';
import { createIsolatedTestDb, assertTestDbSafety } from './test_helpers/testDb';

async function runPatientFileNumberingTests() {
  console.log('======================================================================');
  console.log('STARTING PATIENT FILE NUMBERING & CONCURRENCY TESTS (ISOLATED DB)');
  console.log('======================================================================\n');

  // 1. Initialize isolated temporary database (Strict guard: no access to real DB)
  const testEnv = await createIsolatedTestDb('file_numbering_tests');
  assertTestDbSafety(testEnv.tempDbPath);

  console.log(`[Safety Guard] Running in isolated test database: ${testEnv.tempDbPath}`);

  // Dynamically load modules bound to isolated test database
  const { patientsRouter, getNextPhysicalFileNumber } = await import('./modules/patients/patients.router');

  const app = Fastify({ logger: false });
  await app.register(patientsRouter, { prefix: '/api/patients' });
  await app.ready();

  async function apiRequest(method: string, url: string, body?: any) {
    const res = await app.inject({
      method: method as any,
      url: `/api/patients${url}`,
      payload: body,
      headers: { 'content-type': 'application/json' }
    });
    const json = JSON.parse(res.body);
    return { status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data: json };
  }

  const { sqlite } = testEnv;

  try {
    // -------------------------------------------------------------------------------------------------
    // TEST 9: Test Safety Verification (Tests must NOT touch real database or backup)
    // -------------------------------------------------------------------------------------------------
    console.log('--- TEST 9: بررسی ایمنی پایگاه داده آزمایشی ---');
    const dbList = sqlite.prepare('PRAGMA database_list').all() as { file: string }[];
    const activeFile = dbList.find(d => d.file)?.file;
    if (!activeFile) throw new Error('Active database file could not be determined');
    assertTestDbSafety(activeFile);
    if (activeFile.includes('clinic-live-backup.db') || activeFile.includes('clinic.db')) {
      throw new Error(`CRITICAL: Connected to production DB: ${activeFile}`);
    }
    console.log(`  [PASS] تست ۹: تست‌ها کاملاً ایزوله هستند و هیچ تماسی با دیتابیس یا بکاپ واقعی وجود ندارد. (${activeFile})`);

    // -------------------------------------------------------------------------------------------------
    // TEST 1 & 2: Base Practice Sequences (Aesthetic MAX=2641 -> 2642, Dental MAX=3500 -> 3501)
    // -------------------------------------------------------------------------------------------------
    console.log('\n--- TEST 1 & 2: قانون شماره‌گذاری مستقل هر مطب ---');

    // Seed aesthetic patient with physical file number '2641'
    sqlite.prepare(`
      INSERT INTO patients (id, file_number, name, mobile, primary_practice, profile_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('pat-aes-base', 'CL-1001', 'بیمار زیبایی پایه', '09121111111', 'aesthetic', 'completed', '1405-01-01');

    sqlite.prepare(`
      INSERT INTO patient_practice_memberships (patient_id, practice, physical_file_number, joined_at)
      VALUES (?, ?, ?, ?)
    `).run('pat-aes-base', 'aesthetic', '2641', '1405-01-01');

    // Seed dental patient with physical file number '3500'
    sqlite.prepare(`
      INSERT INTO patients (id, file_number, name, mobile, primary_practice, profile_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('pat-den-base', 'CL-1002', 'بیمار دندانپزشکی پایه', '09122222222', 'dental', 'completed', '1405-01-01');

    sqlite.prepare(`
      INSERT INTO patient_practice_memberships (patient_id, practice, physical_file_number, joined_at)
      VALUES (?, ?, ?, ?)
    `).run('pat-den-base', 'dental', '3500', '1405-01-01');

    // TEST 1: Create new patient in aesthetic -> Must get 2642
    const resAesthetic = await apiRequest('POST', '', {
      name: 'مریم احمدی',
      mobile: '09123333333',
      primaryPractice: 'aesthetic'
    });

    if (!resAesthetic.ok) throw new Error(`Failed to create aesthetic patient: ${JSON.stringify(resAesthetic.data)}`);
    const aesMem = resAesthetic.data.data.memberships.find((m: any) => m.practice === 'aesthetic');
    if (!aesMem || aesMem.physicalFileNumber !== '2642') {
      throw new Error(`Expected aesthetic physicalFileNumber to be '2642', got '${aesMem?.physicalFileNumber}'`);
    }
    console.log(`  [PASS] تست ۱: آخرین شماره زیبایی ۲۶۴۱ بود و بیمار جدید در زیبایی شماره ۲۶۴۲ گرفت. (مقدار: ${aesMem.physicalFileNumber})`);

    // TEST 2: Create new patient in dental -> Must get 3501
    const resDental = await apiRequest('POST', '', {
      name: 'علی حسینی',
      mobile: '09124444444',
      primaryPractice: 'dental'
    });

    if (!resDental.ok) throw new Error(`Failed to create dental patient: ${JSON.stringify(resDental.data)}`);
    const denMem = resDental.data.data.memberships.find((m: any) => m.practice === 'dental');
    if (!denMem || denMem.physicalFileNumber !== '3501') {
      throw new Error(`Expected dental physicalFileNumber to be '3501', got '${denMem?.physicalFileNumber}'`);
    }
    console.log(`  [PASS] تست ۲: آخرین شماره دندانپزشکی ۳۵۰۰ بود و بیمار جدید در دندانپزشکی شماره ۳۵۰۱ گرفت. (مقدار: ${denMem.physicalFileNumber})`);

    // -------------------------------------------------------------------------------------------------
    // TEST 3: Cross-Practice Independence (Large numbers in dental must NOT affect aesthetic)
    // -------------------------------------------------------------------------------------------------
    console.log('\n--- TEST 3: استقلال کامل شماره‌گذاری دو مطب از یکدیگر ---');
    // Notice dental is now at 3501 (much higher than aesthetic at 2642).
    // Let's insert an extremely large dental number: 88888
    sqlite.prepare(`
      INSERT INTO patients (id, file_number, name, mobile, primary_practice, profile_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('pat-den-huge', 'CL-1003', 'بیمار دندان با پرونده بزرگ', '09125555555', 'dental', 'completed', '1405-01-01');

    sqlite.prepare(`
      INSERT INTO patient_practice_memberships (patient_id, practice, physical_file_number, joined_at)
      VALUES (?, ?, ?, ?)
    `).run('pat-den-huge', 'dental', '88888', '1405-01-01');

    // Create another aesthetic patient -> Must be 2643! Dental's 88888 must have ZERO effect!
    const resAestheticNext = await apiRequest('POST', '', {
      name: 'زهرا کاظمی',
      mobile: '09126666666',
      primaryPractice: 'aesthetic'
    });

    if (!resAestheticNext.ok) throw new Error(`Failed to create aesthetic patient: ${JSON.stringify(resAestheticNext.data)}`);
    const aesMemNext = resAestheticNext.data.data.memberships.find((m: any) => m.practice === 'aesthetic');
    if (!aesMemNext || aesMemNext.physicalFileNumber !== '2643') {
      throw new Error(`Expected aesthetic physicalFileNumber to be '2643', got '${aesMemNext?.physicalFileNumber}'`);
    }
    console.log(`  [PASS] تست ۳: وجود شماره بزرگ در دندانپزشکی (۸۸۸۸۸) روی مطب زیبایی تأثیری نگذاشت و زیبایی شماره ۲۶۴۳ گرفت.`);

    // -------------------------------------------------------------------------------------------------
    // TEST 4: Independence from Total Patient Count & Internal ID
    // -------------------------------------------------------------------------------------------------
    console.log('\n--- TEST 4: عدم تأثیر تعداد بیماران یا شناسه داخلی بر شماره پرونده فیزیکی ---');
    // Add 25 dummy patients with huge internal IDs and no aesthetic memberships
    for (let i = 1; i <= 25; i++) {
      sqlite.prepare(`
        INSERT INTO patients (id, file_number, name, mobile, primary_practice, profile_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(`pat-999999999999-${i}`, `CL-${5000 + i}`, `بیمار متفرقه ${i}`, `091000000${i.toString().padStart(2, '0')}`, 'aesthetic', 'completed', '1405-01-01');
    }

    const totalPtsCount = sqlite.prepare('SELECT count(*) as c FROM patients').get() as { c: number };
    console.log(`      تعداد کل بیماران ثبت‌شده در سیستم اکنون: ${totalPtsCount.c}`);

    // Create a new aesthetic patient: should be 2644 (which is MAX(aesthetic)=2643 + 1), completely unaffected by total patient count (30+)
    const resAestheticPtCount = await apiRequest('POST', '', {
      name: 'سارا میرزایی',
      mobile: '09127777777',
      primaryPractice: 'aesthetic'
    });

    if (!resAestheticPtCount.ok) throw new Error(`Failed to create patient: ${JSON.stringify(resAestheticPtCount.data)}`);
    const aesMemPtCount = resAestheticPtCount.data.data.memberships.find((m: any) => m.practice === 'aesthetic');
    if (!aesMemPtCount || aesMemPtCount.physicalFileNumber !== '2644') {
      throw new Error(`Expected physicalFileNumber to be '2644', got '${aesMemPtCount?.physicalFileNumber}'`);
    }
    console.log(`  [PASS] تست ۴: تعداد کل بیماران (${totalPtsCount.c}) و شناسه داخلی تأثیری بر شماره فیزیکی ندارد. (شماره دریافت شده: ${aesMemPtCount.physicalFileNumber})`);

    // -------------------------------------------------------------------------------------------------
    // TEST 5: Adding Existing Patient to Second Clinic (Preserves 1st clinic's file number)
    // -------------------------------------------------------------------------------------------------
    console.log('\n--- TEST 5: افزودن بیمار موجود به مطب دوم بدون تغییر شماره مطب اول ---');
    // 'مریم احمدی' (aesthetic 2642) is added to dental
    const patientMariamId = resAesthetic.data.data.id;
    const addMemRes = await apiRequest('POST', `/${patientMariamId}/memberships`, {
      practice: 'dental'
    });

    if (!addMemRes.ok) throw new Error(`Failed to add dental membership: ${JSON.stringify(addMemRes.data)}`);
    const updatedMariam = addMemRes.data.data;

    const mariamAesMem = updatedMariam.memberships.find((m: any) => m.practice === 'aesthetic');
    const mariamDenMem = updatedMariam.memberships.find((m: any) => m.practice === 'dental');

    if (!mariamAesMem || mariamAesMem.physicalFileNumber !== '2642') {
      throw new Error(`Mariam aesthetic file number was unexpectedly altered: ${mariamAesMem?.physicalFileNumber}`);
    }
    // Dental had 3500, 3501, 88888. So next dental should be 88889!
    if (!mariamDenMem || mariamDenMem.physicalFileNumber !== '88889') {
      throw new Error(`Expected Mariam dental file number to be '88889', got '${mariamDenMem?.physicalFileNumber}'`);
    }
    console.log(`  [PASS] تست ۵: بیمار پس از عضویت در مطب دوم، هر دو عضویت را دارد: زیبایی = ${mariamAesMem.physicalFileNumber} (دست‌نخورده) و دندانپزشکی = ${mariamDenMem.physicalFileNumber} (مبتنی بر مطب مقصد)`);

    // -------------------------------------------------------------------------------------------------
    // TEST 6: Manual File Number Handling (customFileNumber)
    // -------------------------------------------------------------------------------------------------
    console.log('\n--- TEST 6: رفتار مستند شماره پرونده دستی (customFileNumber) ---');

    // 6.1: Valid unique customFileNumber is accepted
    const resCustomOk = await apiRequest('POST', '', {
      name: 'سعید مرادی',
      mobile: '09128888888',
      primaryPractice: 'aesthetic',
      customFileNumber: '9999'
    });
    if (!resCustomOk.ok) throw new Error(`Failed to create with customFileNumber: ${JSON.stringify(resCustomOk.data)}`);
    const customMem = resCustomOk.data.data.memberships.find((m: any) => m.practice === 'aesthetic');
    if (customMem.physicalFileNumber !== '9999') {
      throw new Error(`Expected custom physicalFileNumber '9999', got '${customMem.physicalFileNumber}'`);
    }
    console.log('  [PASS] تست ۶.۱: ثبت موفق شماره پرونده دستی یکتا (۹۹۹۹)');

    // 6.2: Duplicate customFileNumber in same practice must return 409 DUPLICATE_FILE_NUMBER
    const resCustomDup = await apiRequest('POST', '', {
      name: 'فرهاد ناصری',
      mobile: '09129999999',
      primaryPractice: 'aesthetic',
      customFileNumber: '9999' // duplicate in aesthetic!
    });
    if (resCustomDup.status !== 409 || resCustomDup.data.error?.code !== 'DUPLICATE_FILE_NUMBER') {
      throw new Error(`Expected 409 DUPLICATE_FILE_NUMBER, got: ${resCustomDup.status} ${JSON.stringify(resCustomDup.data)}`);
    }
    console.log('  [PASS] تست ۶.۲: رد شدن صحیح شماره دستی تکراری با خطای DUPLICATE_FILE_NUMBER (کد ۴۰۹)');

    // 6.3: Empty or whitespace customFileNumber falls back cleanly to auto-generated next number
    const resCustomEmpty = await apiRequest('POST', '', {
      name: 'آرزو شاکری',
      mobile: '09121234567',
      primaryPractice: 'aesthetic',
      customFileNumber: '   '
    });
    if (!resCustomEmpty.ok) throw new Error(`Failed: ${JSON.stringify(resCustomEmpty.data)}`);
    const memEmpty = resCustomEmpty.data.data.memberships.find((m: any) => m.practice === 'aesthetic');
    // MAX in aesthetic was 9999, so next should be 10000!
    if (memEmpty.physicalFileNumber !== '10000') {
      throw new Error(`Expected fallback to '10000', got '${memEmpty.physicalFileNumber}'`);
    }
    console.log('  [PASS] تست ۶.۳: ارسال مقدار خالی برای customFileNumber مانع تولید خودکار شماره نشد (شماره تخصیص‌یافته: ۱۰۰۰۰)');

    // 6.4: PATCH updates physicalFileNumber
    const patchRes = await apiRequest('PATCH', `/${resCustomEmpty.data.data.id}/memberships/aesthetic`, {
      physicalFileNumber: '10005'
    });
    if (!patchRes.ok) throw new Error(`PATCH failed: ${JSON.stringify(patchRes.data)}`);
    const patchedMem = patchRes.data.data.memberships.find((m: any) => m.practice === 'aesthetic');
    if (patchedMem.physicalFileNumber !== '10005') {
      throw new Error(`Expected patched number to be '10005', got '${patchedMem.physicalFileNumber}'`);
    }
    console.log('  [PASS] تست ۶.۴: ویرایش شماره پرونده فیزیکی از طریق PATCH با موفقیت انجام شد (۱۰MDA->۱۰۰۰۵)');

    // -------------------------------------------------------------------------------------------------
    // TEST 7: Concurrency Safety (No duplicate file numbers produced under concurrent calls)
    // -------------------------------------------------------------------------------------------------
    console.log('\n--- TEST 7: بررسی ایمنی همزمانی (Concurrency) و عدم تولید شماره تکراری ---');
    // Launch 10 simultaneous requests to create patients in dental
    const persianNames = [
      'علی کریمی', 'محمد علیزاده', 'رضا صادقی', 'حسین طاهری', 'امیر موسوی',
      'مهدی جعفری', 'حسن مرادی', 'امید نجفی', 'یاسر ابراهیمی', 'پویا سلیمانی'
    ];
    const concurrentPromises = [];

    for (let i = 0; i < persianNames.length; i++) {
      concurrentPromises.push(
        apiRequest('POST', '', {
          name: persianNames[i],
          mobile: `093500000${i.toString().padStart(2, '0')}`,
          primaryPractice: 'dental'
        })
      );
    }

    const concurrentResults = await Promise.all(concurrentPromises);
    const generatedDentalNumbers = new Set<string>();

    for (const r of concurrentResults) {
      if (!r.ok) throw new Error(`Concurrent creation failed: ${JSON.stringify(r.data)}`);
      const mem = r.data.data.memberships.find((m: any) => m.practice === 'dental');
      if (!mem) throw new Error('Missing dental membership in concurrent result');
      if (generatedDentalNumbers.has(mem.physicalFileNumber)) {
        throw new Error(`RACE CONDITION DETECTED! Duplicate dental number generated: ${mem.physicalFileNumber}`);
      }
      generatedDentalNumbers.add(mem.physicalFileNumber);
    }

    console.log(`  [PASS] تست ۷: ۱۰ درخواست همزمان با موفقیت اجرا شدند و ۱۰ شماره کاملاً یکتا و بدون تداخل تولید شد:`);
    console.log(`         شماره‌ها: ${Array.from(generatedDentalNumbers).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).join(', ')}`);

    // -------------------------------------------------------------------------------------------------
    // TEST 8: Old Patient Numbers Do NOT Change Without Reason
    // -------------------------------------------------------------------------------------------------
    console.log('\n--- TEST 8: تضمین عدم تغییر ناخواسته شماره‌های قدیمی بیماران ---');
    const baseAestheticCheck = sqlite.prepare(`
      SELECT physical_file_number FROM patient_practice_memberships WHERE patient_id = 'pat-aes-base' AND practice = 'aesthetic'
    `).get() as { physical_file_number: string };

    const baseDentalCheck = sqlite.prepare(`
      SELECT physical_file_number FROM patient_practice_memberships WHERE patient_id = 'pat-den-base' AND practice = 'dental'
    `).get() as { physical_file_number: string };

    if (baseAestheticCheck.physical_file_number !== '2641') {
      throw new Error(`Base aesthetic file number changed! Expected '2641', got '${baseAestheticCheck.physical_file_number}'`);
    }
    if (baseDentalCheck.physical_file_number !== '3500') {
      throw new Error(`Base dental file number changed! Expected '3500', got '${baseDentalCheck.physical_file_number}'`);
    }

    console.log(`  [PASS] تست ۸: پرونده‌های پایه ۲۶۴۱ (زیبایی) و ۳۵۰۰ (دندانپزشکی) بدون تغییر و با صحت کامل حفظ شدند.`);

    console.log('\n======================================================================');
    console.log('ALL 9 MANDATORY TESTS PASSED SUCCESSFULLY! ✅');
    console.log('======================================================================');
  } finally {
    testEnv.cleanup();
  }
}

runPatientFileNumberingTests().catch((err) => {
  console.error('\n❌ TEST RUN FAILED:', err);
  process.exit(1);
});
