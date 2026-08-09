
document.getElementById('year').textContent = new Date().getFullYear();

const menuBtn = document.querySelector('.menu-btn');
const nav = document.querySelector('.navlinks');
menuBtn.addEventListener('click', () => {
  const open = nav.classList.toggle('open');
  menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
});
document.querySelectorAll('.navlinks a').forEach(a => a.addEventListener('click', () => nav.classList.remove('open')));

const serviceInput = document.getElementById('service');
const dateInput = document.getElementById('date');
const timeInput = document.getElementById('time');
const timeSlots = document.getElementById('timeSlots');
const statusBox = document.getElementById('schedulerStatus');
const confirmation = document.getElementById('confirmation');
const bookButton = document.getElementById('bookButton');

const today = new Date();
const yyyy = today.getFullYear();
const mm = String(today.getMonth() + 1).padStart(2, '0');
const dd = String(today.getDate()).padStart(2, '0');
dateInput.min = `${yyyy}-${mm}-${dd}`;

function setStatus(message) {
  statusBox.textContent = message || '';
}

function isWeekday(dateString) {
  const d = new Date(`${dateString}T12:00:00`);
  const day = d.getDay();
  return day >= 1 && day <= 5;
}

async function loadAvailability() {
  timeInput.value = '';
  confirmation.hidden = true;

  if (!serviceInput.value || !dateInput.value) {
    timeSlots.innerHTML = '<p class="slot-help">Choose a service and date to load available times.</p>';
    return;
  }

  if (!isWeekday(dateInput.value)) {
    timeSlots.innerHTML = '<p class="slot-help">S&K Auto is closed Saturday and Sunday. Please choose Monday–Friday.</p>';
    return;
  }

  setStatus('Checking live availability…');
  timeSlots.innerHTML = '<p class="slot-help">Loading available times…</p>';

  try {
    const res = await fetch(`/api/availability?date=${encodeURIComponent(dateInput.value)}`);
    if (!res.ok) throw new Error('Unable to load availability');
    const data = await res.json();

    if (!data.available || data.available.length === 0) {
      timeSlots.innerHTML = '<p class="slot-help">No appointment times are available for this date. Please choose another day.</p>';
      setStatus('');
      return;
    }

    timeSlots.innerHTML = '';
    data.available.forEach(time => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'slot-btn';
      btn.textContent = time;
      btn.addEventListener('click', () => {
        document.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        timeInput.value = time;
      });
      timeSlots.appendChild(btn);
    });
    setStatus('');
  } catch (err) {
    timeSlots.innerHTML = '<p class="slot-help">The live scheduler is not connected yet. Deploy the included server to enable real-time booking.</p>';
    setStatus('Scheduling server unavailable.');
  }
}

serviceInput.addEventListener('change', loadAvailability);
dateInput.addEventListener('change', loadAvailability);

bookButton.addEventListener('click', async () => {
  const booking = {
    service: serviceInput.value.trim(),
    vehicle: document.getElementById('vehicle').value.trim(),
    date: dateInput.value,
    time: timeInput.value,
    name: document.getElementById('name').value.trim(),
    phone: document.getElementById('phone').value.trim(),
    email: document.getElementById('email').value.trim(),
    notes: document.getElementById('notes').value.trim()
  };

  if (!booking.service || !booking.vehicle || !booking.date || !booking.time || !booking.name || !booking.phone) {
    setStatus('Please complete the service, vehicle, date, time, name, and phone fields.');
    return;
  }

  bookButton.disabled = true;
  setStatus('Reserving your appointment…');

  try {
    const res = await fetch('/api/book', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(booking)
    });
    const data = await res.json();

    if (!res.ok) {
      if (res.status === 409) {
        setStatus('That time was just booked by another customer. Please choose another available time.');
        await loadAvailability();
        return;
      }
      throw new Error(data.error || 'Booking failed');
    }

    confirmation.hidden = false;
    confirmation.innerHTML = `<strong>Appointment confirmed.</strong><br>
      ${booking.name}, you are booked for <strong>${booking.service}</strong> on
      <strong>${booking.date}</strong> at <strong>${booking.time}</strong>.<br>
      <small>Confirmation #${data.confirmation}</small>`;
    setStatus('');
    await loadAvailability();
    confirmation.hidden = false;
  } catch (err) {
    setStatus('We could not complete the booking. Please call S&K Auto at (620) 899-0425.');
  } finally {
    bookButton.disabled = false;
  }
});
