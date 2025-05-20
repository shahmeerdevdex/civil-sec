const schedule = require("node-schedule");
const pool = require("../database");
const twilio = require("twilio");
const async = require("async");
const moment = require("moment-timezone");

let queryJobCall = `UPDATE jobs SET job_status = false, call_active = false, job_message = $2 WHERE id = $1`;
let queryCallMsg = `UPDATE jobs SET call_active = false, job_message = $2 WHERE id = $1`;
let queryCall = `UPDATE jobs SET call_active = false WHERE id = $1`;

const checkJobStatus = async (jobId, userId) => {
  try {
    const jobDetails = await pool.query(
      `SELECT j.job_status, j.call_active, j.start_datetime, j.end_datetime, 
              j.job_message, p.id AS phone_id, p.end_datetime AS phone_end_datetime
       FROM jobs j
       LEFT JOIN phone_numbers p ON j.phoneno_id = p.id
       WHERE j.id = $1`,
      [jobId]
    );

    const job = jobDetails.rows[0];

    if (!job.job_status || !job.call_active) {
      return {
        isJobActive: false,
        query: queryJobCall,
        message: "Job is no longer active. Terminating call.",
      };
    }

    const subResult = await pool.query(
      `SELECT us.id, us.end_datetime, us.amount, us.top_up_balance, 
       sp.concurrent_calls 
       FROM user_subscriptions us
       INNER JOIN subscription_plans sp ON us.plan_id = sp.id
       WHERE us.uid = $1 AND us.status = true`,
      [userId]
    );

    if (subResult.rowCount === 0) {
      return {
        isJobActive: false,
        query: queryJobCall,
        message: "Calls are terminating due to no active subscription found.",
      };
    }

    const currentDateTime = moment();
    const subscription = subResult.rows[0];
    const subEndDateTime = moment(subscription?.end_datetime);
    if (subEndDateTime.isBefore(currentDateTime)) {
      return {
        isJobActive: false,
        query: queryJobCall,
        message: "Calls are terminating because your subscription has expired.",
      };
    }

    if (
      parseFloat(subscription.amount) <= 0 &&
      parseFloat(subscription.top_up_balance) <= 0
    ) {
      return {
        isJobActive: false,
        query: queryJobCall,
        message: "Calls are terminating due to insufficient balance.",
      };
    }

    if (!job.phone_id) {
      return {
        isJobActive: false,
        query: queryJobCall,
        message:
          "Calls are terminating because no phone number is associated with the job.",
      };
    }

    const phoneEndDateTime = moment(job.phone_end_datetime);
    if (phoneEndDateTime.isBefore(currentDateTime)) {
      return {
        isJobActive: false,
        query: queryJobCall,
        message:
          "Calls are terminating because the phone number's subscription has expired.",
      };
    }

    const currentTime = new Date();
    const startDateTime = new Date(job.start_datetime);
    const endDateTime = new Date(job.end_datetime);

    if (currentTime < startDateTime || currentTime > endDateTime) {
      return {
        isJobActive: false,
        query: queryJobCall,
        message: "Job time and date have ended.",
      };
    }

    const currentHours = currentTime.getHours();
    const currentMinutes = currentTime.getMinutes();

    const startHours = startDateTime.getHours();
    const startMinutes = startDateTime.getMinutes();
    const endHours = endDateTime.getHours();
    const endMinutes = endDateTime.getMinutes();

    let isWithinTimeRange = false;

    if (startHours <= endHours) {
      isWithinTimeRange =
        (currentHours > startHours ||
          (currentHours === startHours && currentMinutes >= startMinutes)) &&
        (currentHours < endHours ||
          (currentHours === endHours && currentMinutes <= endMinutes));
    } else {
      isWithinTimeRange =
        currentHours > startHours ||
        (currentHours === startHours && currentMinutes >= startMinutes) ||
        currentHours < endHours ||
        (currentHours === endHours && currentMinutes <= endMinutes);
    }

    if (!isWithinTimeRange) {
      return {
        isJobActive: false,
        query: queryCallMsg,
        message:
          "Job is outside the scheduled working hours. Further calls have been stopped.",
      };
    }

    return { isJobActive: true, query: "", message: "" };
  } catch (error) {
    return {
      isJobActive: false,
      query: queryJobCall,
      message: "An error occurred while checking the job status.",
    };
  }
};

const processJob = async (job) => {
  try {
    const { id, uid, phoneno_id, customer_list_id, timezone } = job;

    const callingDetails = await pool.query(
      `SELECT pn.phone_no, pn.subscription_type, u.twilio_sid, u.twilio_token, cl.list 
         FROM phone_numbers pn
         JOIN users u ON pn.uid = u.id
         JOIN customer_list cl ON cl.id = $1 AND cl.uid = u.id
         WHERE pn.id = $2 AND pn.uid = $3`,
      [customer_list_id, phoneno_id, uid]
    );

    const { phone_no, twilio_sid, twilio_token, list, subscription_type } =
      callingDetails.rows[0];

    let client;
    if (subscription_type === "Trial") {
      client = new twilio(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      );
    } else {
      client = new twilio(twilio_sid, twilio_token);
    }
    const customerList = list?.map((item) => JSON.parse(item));

    let activeCalls = 0;
    for (const customer of customerList) {
      const existingActivity = await pool.query(
        `SELECT id FROM job_activity WHERE phone_no = $1 AND job_id = $2`,
        [customer.phoneNumber, id]
      );
      if (existingActivity.rows.length > 0) continue;

      while (activeCalls >= 2) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      const { isJobActive, query, message } = await checkJobStatus(id, uid);
      if (!isJobActive) {
        await pool.query(query, [job.id, message]);
        return;
      }

      const currentDate = moment().tz(timezone);
      const jobActivity = await pool.query(
        `INSERT INTO job_activity (uid, job_id, phone_no, call_status, call_type, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          uid,
          id,
          customer.phoneNumber,
          "calling",
          "Make Calls",
          currentDate.toDate(),
        ]
      );
      const jobActivityId = jobActivity.rows[0].id;

      activeCalls++;
      const call = await client.calls.create({
        to: customer.phoneNumber,
        from: phone_no,
        twiml: `
            <Response>
             <Connect>
                <Stream url="${process.env.SERVER_SOCKET_URL}/${id}/${jobActivityId}" />
             </Connect>
            </Response>`,
      });

      (async () => {
        try {
          await new Promise((resolve) => setTimeout(resolve, 10000));
          let callCompleted = false;
          while (!callCompleted) {
            console.log("Checking either call is completed or not");
            const callDetails = await client.calls(call.sid).fetch();
            if (
              ["completed", "no-answer", "failed", "canceled", "busy"].includes(
                callDetails.status
              )
            ) {
              callCompleted = true;
              const callDuration = callDetails.duration;
              await pool.query(
                `UPDATE job_activity
               SET call_status = $1, call_duration = $2
               WHERE id = $3`,
                [callDetails.status, callDuration, jobActivityId]
              );
              activeCalls--;
            } else {
              await new Promise((resolve) => setTimeout(resolve, 10000));
            }
          }
        } catch (error) {
          activeCalls--;
          console.error("Error in call monitoring:", error);
        }
      })();
    }

    while (activeCalls > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    console.log("All Calls Completed");
    const existingMessage = await pool.query(
      `SELECT job_message FROM jobs WHERE id = $1`,
      [job.id]
    );

    await pool.query(queryJobCall, [
      job.id,
      existingMessage.rows[0]?.job_message ||
        "All calls have been successfully placed.",
    ]);
  } catch (error) {
    console.error(`Error processing job ${job.id}:`, error);
    try {
      if (error.code === 429) {
        await pool.query(queryCall, [job.id]);
      } else {
        await pool.query(queryJobCall, [job.id, error.message]);
      }
    } catch (e) {}
  }
};

const queue = async.queue(async (job, callback) => {
  await processJob(job);
  callback();
}, 10000);

const handleOutbound = async () => {
  try {
    const currentTime = new Date();

    const jobsQuery = await pool.query(
      `SELECT id, uid, phoneno_id, customer_list_id, start_datetime, end_datetime, timezone
     FROM jobs
     WHERE job_status = TRUE
     AND call_active = FALSE
     AND job_type = 'Make Calls'
     AND start_datetime <= $1
     AND end_datetime >= $1`,
      [currentTime]
    );

    const jobs = jobsQuery.rows;

    if (jobs.length > 0) {
      jobs.forEach(async (job) => {
        const { start_datetime, end_datetime } = job;
        const jobStartTime = new Date(start_datetime);
        const jobEndTime = new Date(end_datetime);

        const jobStartHour = jobStartTime.getHours();
        const jobStartMinute = jobStartTime.getMinutes();
        const jobEndHour = jobEndTime.getHours();
        const jobEndMinute = jobEndTime.getMinutes();

        const currentHour = currentTime.getHours();
        const currentMinute = currentTime.getMinutes();

        let isWithinTimeRange = false;

        if (jobStartHour <= jobEndHour) {
          isWithinTimeRange =
            (currentHour > jobStartHour ||
              (currentHour === jobStartHour &&
                currentMinute >= jobStartMinute)) &&
            (currentHour < jobEndHour ||
              (currentHour === jobEndHour && currentMinute <= jobEndMinute));
        } else {
          isWithinTimeRange =
            currentHour > jobStartHour ||
            (currentHour === jobStartHour && currentMinute >= jobStartMinute) ||
            currentHour < jobEndHour ||
            (currentHour === jobEndHour && currentMinute <= jobEndMinute);
        }

        if (isWithinTimeRange) {
          await pool.query(`UPDATE jobs SET call_active = TRUE WHERE id = $1`, [
            job.id,
          ]);

          queue.push(job);
        }
      });
    }
  } catch (error) {
    console.log("Error occur while checking running jobs", error);
  }
};

const startScheduler = () => {
  schedule.scheduleJob("*/1 * * * *", async () => {
    await handleOutbound();
  });
};

module.exports = { startScheduler };

// checkJobStatus(497)
// America/New_York
// Asia/Karachi
// Pacific/Honolulu
// Pacific/Kiritimati
