from datetime import datetime
from werkzeug.security import generate_password_hash, check_password_hash
from flask_login import UserMixin

from extensions import db


class User(db.Model, UserMixin):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False, index=True)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    full_name = db.Column(db.String(120))
    role = db.Column(db.String(30), default="staff")
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def set_password(self, raw):
        self.password_hash = generate_password_hash(raw)

    def check_password(self, raw):
        return check_password_hash(self.password_hash, raw)


class Company(db.Model):
    __tablename__ = "companies"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(200), unique=True, nullable=False, index=True)
    address = db.Column(db.String(300))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    architects = db.relationship("Architect", back_populates="company")


class Architect(db.Model):
    """Architect / Engineer (the firm contact who hires us)."""

    __tablename__ = "architects"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(200), nullable=False, index=True)
    title = db.Column(db.String(80))
    phone = db.Column(db.String(60))
    email = db.Column(db.String(120))
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id"))
    notes = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    company = db.relationship("Company", back_populates="architects")
    proposals = db.relationship("Proposal", back_populates="architect")


class Client(db.Model):
    """End-client / project owner (the building owner)."""

    __tablename__ = "clients"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(200), nullable=False, index=True)
    phone = db.Column(db.String(60))
    email = db.Column(db.String(120))
    address = db.Column(db.String(300))
    notes = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    proposals = db.relationship("Proposal", back_populates="client")


class Proposal(db.Model):
    __tablename__ = "proposals"

    id = db.Column(db.Integer, primary_key=True)
    project_number = db.Column(db.String(20), unique=True, index=True)

    date_received = db.Column(db.Date, default=datetime.utcnow)
    date_proposed = db.Column(db.Date, default=datetime.utcnow)

    project_title = db.Column(db.String(300), nullable=False)
    category = db.Column(db.String(200), default="Structural Design")
    location = db.Column(db.String(300))

    client_id = db.Column(db.Integer, db.ForeignKey("clients.id"))
    architect_id = db.Column(db.Integer, db.ForeignKey("architects.id"))

    # Pricing
    lot_area_sqm = db.Column(db.Float)
    rate_per_sqm = db.Column(db.Float)
    sheet_count = db.Column(db.Integer)
    rate_per_sheet = db.Column(db.Float)
    price = db.Column(db.Float, default=0)
    price_approved = db.Column(db.Float)
    payed = db.Column(db.Float, default=0)

    # Status
    status = db.Column(
        db.String(30), default="Draft"
    )  # Draft, Submitted, Approved, Rejected, Paid
    payment_method = db.Column(db.String(60))
    date_approved = db.Column(db.Date)

    # Proposal letter content
    scope_of_work = db.Column(db.Text)
    deliverables = db.Column(db.Text)
    schedule_duration = db.Column(db.String(200))
    payment_terms = db.Column(db.Text)
    remarks = db.Column(db.Text)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    created_by_id = db.Column(db.Integer, db.ForeignKey("users.id"))

    client = db.relationship("Client", back_populates="proposals")
    architect = db.relationship("Architect", back_populates="proposals")
    created_by = db.relationship("User")

    @property
    def payable(self):
        approved = self.price_approved or self.price or 0
        return max(0, approved - (self.payed or 0))

    @property
    def display_price(self):
        if self.price is None:
            return ""
        if self.price == 0:
            return "Minimum"
        return f"₱{self.price:,.2f}"
